#include "AudioIO.h"
#include "Ring.h"
#include "Resampler.h"
#include <AudioToolbox/AudioToolbox.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>

#define MAX_FRAMES 8192u
struct SFRoute {
    AudioUnit input, output;
    AudioBufferList *capture;
    SFRing *ring;
    SFResampler *resampler;
    double rate, inputRate;
    _Atomic bool muted;
    _Atomic uint64_t capturedFrames, outputFrames;
    _Atomic uint32_t inputPeak, outputPeak;
    _Atomic int32_t error;
};

// RT callbacks use preallocated buffers and lock-free scalar statistics only.
static uint32_t peak(const float *data, UInt32 frames) {
    float value = 0;
    for (UInt32 i = 0; i < frames; i++) value = fmaxf(value, fabsf(data[i]));
    return (uint32_t)(fminf(value, 1.0f) * 1000000.0f);
}
static OSStatus capture(void *context, AudioUnitRenderActionFlags *flags,
                        const AudioTimeStamp *time, UInt32 bus, UInt32 frames, AudioBufferList *unused) {
    SFRoute *route = context;
    if (frames > MAX_FRAMES) { atomic_store(&route->error, kAudioUnitErr_TooManyFramesToProcess); return noErr; }
    for (UInt32 c = 0; c < route->capture->mNumberBuffers; c++) route->capture->mBuffers[c].mDataByteSize = frames * sizeof(float);
    OSStatus result = AudioUnitRender(route->input, flags, time, 1, frames, route->capture);
    if (result) { atomic_store(&route->error, result); return noErr; }
    const float *left = route->capture->mBuffers[0].mData;
    const float *right = route->capture->mNumberBuffers > 1 ? route->capture->mBuffers[1].mData : NULL;
    sf_ring_write(route->ring, left, right, frames);
    atomic_store(&route->inputPeak, peak(left, frames));
    atomic_fetch_add(&route->capturedFrames, frames);
    return noErr;
}
static OSStatus playback(void *context, AudioUnitRenderActionFlags *flags,
                         const AudioTimeStamp *time, UInt32 bus, UInt32 frames, AudioBufferList *data) {
    SFRoute *route = context;
    if (!data) return noErr;
    if (data->mNumberBuffers != 2 || !data->mBuffers[0].mData || !data->mBuffers[1].mData ||
        data->mBuffers[0].mDataByteSize / sizeof(float) < frames || data->mBuffers[1].mDataByteSize / sizeof(float) < frames) {
        for (UInt32 c = 0; c < data->mNumberBuffers; c++) if (data->mBuffers[c].mData) memset(data->mBuffers[c].mData, 0, data->mBuffers[c].mDataByteSize);
        atomic_store(&route->error, kAudioUnitErr_FormatNotSupported);
        return noErr;
    }
    if (route->resampler) {
        OSStatus result = sf_resampler_render(route->resampler, frames, data);
        if (result) {
            atomic_store(&route->error, result);
            for (UInt32 c = 0; c < 2; c++) memset(data->mBuffers[c].mData, 0, frames * sizeof(float));
        }
    } else sf_ring_read(route->ring, data->mBuffers[0].mData, data->mBuffers[1].mData, frames);
    // Gate after conversion too: the converter may retain a few filter-history samples.
    if (atomic_load(&route->muted)) {
        for (UInt32 c = 0; c < 2; c++) memset(data->mBuffers[c].mData, 0, frames * sizeof(float));
    }
    atomic_store(&route->outputPeak, peak(data->mBuffers[0].mData, frames));
    atomic_fetch_add(&route->outputFrames, frames);
    return noErr;
}
void sf_route_stop(SFRoute *route) {
    if (!route) return;
    // Stop and dispose both units before releasing memory referenced by their callbacks.
    if (route->input) { AudioOutputUnitStop(route->input); AudioUnitUninitialize(route->input); AudioComponentInstanceDispose(route->input); }
    if (route->output) { AudioOutputUnitStop(route->output); AudioUnitUninitialize(route->output); AudioComponentInstanceDispose(route->output); }
    if (route->capture) {
        for (UInt32 c = 0; c < route->capture->mNumberBuffers; c++) free(route->capture->mBuffers[c].mData);
        free(route->capture);
    }
    sf_resampler_destroy(route->resampler);
    sf_ring_destroy(route->ring);
    free(route);
}
static AudioStreamBasicDescription format(double rate, UInt32 channels) {
    return (AudioStreamBasicDescription){.mSampleRate = rate, .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved,
        .mBytesPerPacket = sizeof(float), .mFramesPerPacket = 1, .mBytesPerFrame = sizeof(float),
        .mChannelsPerFrame = channels, .mBitsPerChannel = 32};
}
SFRoute *sf_route_start(AudioDeviceID inputID, AudioDeviceID outputID, char *error, size_t capacity) {
    SFRoute *route = calloc(1, sizeof(SFRoute));
    OSStatus result = noErr; const char *stage = "分配音频缓冲";
    if (!route) { snprintf(error, capacity, "虚拟麦克风开启失败，请换一个麦克风再试。（错误代码：无法分配音频缓冲）"); return NULL; }
    route->ring = sf_ring_create();
    if (!route->ring) { result = kAudio_MemFullError; goto fail; }
    AudioComponentDescription description = {.componentType = kAudioUnitType_Output,
        .componentSubType = kAudioUnitSubType_HALOutput, .componentManufacturer = kAudioUnitManufacturer_Apple};
    AudioComponent component = AudioComponentFindNext(NULL, &description);
    if (!component) { result = kAudioUnitErr_InvalidProperty; goto fail; }
#define CHECK(label, call) do { stage = label; result = (call); if (result != noErr) goto fail; } while (0)
    CHECK("创建输入单元", AudioComponentInstanceNew(component, &route->input));
    CHECK("创建输出单元", AudioComponentInstanceNew(component, &route->output));
    UInt32 on = 1, off = 0, maxFrames = MAX_FRAMES;
    CHECK("启用输入", AudioUnitSetProperty(route->input, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, sizeof(on)));
    CHECK("关闭输入单元的播放", AudioUnitSetProperty(route->input, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, sizeof(off)));
    CHECK("选择输入设备", AudioUnitSetProperty(route->input, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &inputID, sizeof(inputID)));
    CHECK("选择内部输出", AudioUnitSetProperty(route->output, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &outputID, sizeof(outputID)));
    AudioStreamBasicDescription hardware = {0}; UInt32 size = sizeof(hardware);
    CHECK("读取输入格式", AudioUnitGetProperty(route->input, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hardware, &size));
    double rate = hardware.mSampleRate;
    if ((rate != 8000 && rate != 16000 && rate != 24000 && rate != 32000 && rate != 44100 && rate != 48000) || hardware.mChannelsPerFrame < 1 || hardware.mChannelsPerFrame > 32) {
        snprintf(error, capacity, "虚拟麦克风开启失败，请换一个麦克风再试。（错误代码：macOS 当前提供的输入格式为 %.0f Hz / %u 声道。本版支持 8 / 16 / 24 / 32 / 44.1 / 48 kHz 输入）", rate, hardware.mChannelsPerFrame);
        sf_route_stop(route); return NULL;
    }
    route->inputRate = rate;
    route->rate = rate < 44100 ? 48000 : rate;
    AudioObjectPropertyAddress rateAddress = {kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    double outputRate = 0; size = sizeof(outputRate);
    CHECK("读取虚拟采样率", AudioObjectGetPropertyData(outputID, &rateAddress, 0, NULL, &size, &outputRate));
    if (outputRate != route->rate) {
        CHECK("设置虚拟采样率", AudioObjectSetPropertyData(outputID, &rateAddress, 0, NULL, sizeof(route->rate), &route->rate));
        for (int attempt = 0; attempt < 50; attempt++) {
            size = sizeof(outputRate);
            CHECK("等待虚拟采样率", AudioObjectGetPropertyData(outputID, &rateAddress, 0, NULL, &size, &outputRate));
            if (outputRate == route->rate) break;
            usleep(10000);
        }
        if (outputRate != route->rate) { result = kAudioUnitErr_FormatNotSupported; goto fail; }
    }
    AudioStreamBasicDescription inputFormat = format(route->inputRate, hardware.mChannelsPerFrame), outputFormat = format(route->rate, 2);
    CHECK("设置输入格式", AudioUnitSetProperty(route->input, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &inputFormat, sizeof(inputFormat)));
    CHECK("设置输出格式", AudioUnitSetProperty(route->output, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &outputFormat, sizeof(outputFormat)));
    CHECK("设置输入缓冲上限", AudioUnitSetProperty(route->input, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, sizeof(maxFrames)));
    CHECK("设置输出缓冲上限", AudioUnitSetProperty(route->output, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, sizeof(maxFrames)));
    CHECK("使用预分配输入缓冲", AudioUnitSetProperty(route->input, kAudioUnitProperty_ShouldAllocateBuffer, kAudioUnitScope_Output, 1, &off, sizeof(off)));
    route->capture = calloc(1, offsetof(AudioBufferList, mBuffers) + hardware.mChannelsPerFrame * sizeof(AudioBuffer));
    if (!route->capture) { stage = "分配输入缓冲"; result = kAudio_MemFullError; goto fail; }
    route->capture->mNumberBuffers = hardware.mChannelsPerFrame;
    for (UInt32 c = 0; c < hardware.mChannelsPerFrame; c++) {
        route->capture->mBuffers[c] = (AudioBuffer){.mNumberChannels = 1, .mDataByteSize = MAX_FRAMES * sizeof(float), .mData = calloc(MAX_FRAMES, sizeof(float))};
        if (!route->capture->mBuffers[c].mData) { stage = "分配通道缓冲"; result = kAudio_MemFullError; goto fail; }
    }
    if (route->inputRate != route->rate) {
        stage = "创建采样率转换";
        route->resampler = sf_resampler_create(route->ring, route->inputRate, route->rate, &result);
        if (!route->resampler) goto fail;
    }
    AURenderCallbackStruct inputCallback = {capture, route}, outputCallback = {playback, route};
    CHECK("注册输入回调", AudioUnitSetProperty(route->input, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &inputCallback, sizeof(inputCallback)));
    CHECK("注册输出回调", AudioUnitSetProperty(route->output, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &outputCallback, sizeof(outputCallback)));
    CHECK("初始化输入", AudioUnitInitialize(route->input));
    CHECK("初始化输出", AudioUnitInitialize(route->output));
    CHECK("启动输出", AudioOutputUnitStart(route->output));
    CHECK("启动输入", AudioOutputUnitStart(route->input));
    return route;
fail:
    snprintf(error, capacity, "虚拟麦克风开启失败，请换一个麦克风再试。（错误代码：%s失败 OSStatus %d）", stage, (int)result);
    sf_route_stop(route); return NULL;
#undef CHECK
}
void sf_route_mute(SFRoute *route, bool muted) { atomic_store(&route->muted, muted); sf_ring_mute(route->ring, muted); }
SFRouteStats sf_route_stats(SFRoute *route) {
    return (SFRouteStats){.capturedFrames = atomic_load(&route->capturedFrames), .outputFrames = atomic_load(&route->outputFrames),
        .inputPeak = atomic_load(&route->inputPeak) / 1000000.0f, .outputPeak = atomic_load(&route->outputPeak) / 1000000.0f,
        .sampleRate = route->rate, .inputSampleRate = route->inputRate, .error = atomic_load(&route->error)};
}
