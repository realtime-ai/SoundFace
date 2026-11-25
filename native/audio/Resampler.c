#include "Resampler.h"
#include <stdlib.h>

#define MAX_OUTPUT_FRAMES 8192u
#define MAX_INPUT_FRAMES 16384u

struct SFResampler {
    AudioUnit unit;
    SFRing *ring;
    double sampleTime;
    float left[MAX_INPUT_FRAMES], right[MAX_INPUT_FRAMES];
};

static OSStatus supply(void *context, AudioUnitRenderActionFlags *flags,
                       const AudioTimeStamp *time, UInt32 bus, UInt32 frames, AudioBufferList *data) {
    SFResampler *s = context;
    if (frames > MAX_INPUT_FRAMES) return kAudioUnitErr_TooManyFramesToProcess;
    if (!data || data->mNumberBuffers != 2) return kAudioUnitErr_FormatNotSupported;
    sf_ring_read(s->ring, s->left, s->right, frames);
    data->mBuffers[0] = (AudioBuffer){1, frames * sizeof(float), s->left};
    data->mBuffers[1] = (AudioBuffer){1, frames * sizeof(float), s->right};
    return noErr;
}

static AudioStreamBasicDescription pcm(double rate) {
    return (AudioStreamBasicDescription){.mSampleRate = rate, .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved,
        .mBytesPerPacket = sizeof(float), .mFramesPerPacket = 1, .mBytesPerFrame = sizeof(float),
        .mChannelsPerFrame = 2, .mBitsPerChannel = 32};
}

void sf_resampler_destroy(SFResampler *s) {
    if (!s) return;
    if (s->unit) { AudioUnitUninitialize(s->unit); AudioComponentInstanceDispose(s->unit); }
    free(s);
}

SFResampler *sf_resampler_create(SFRing *ring, double inputRate, double outputRate, OSStatus *error) {
    *error = noErr;
    SFResampler *s = calloc(1, sizeof(SFResampler));
    if (!s) { *error = kAudio_MemFullError; return NULL; }
    s->ring = ring;
    AudioComponentDescription description = {.componentType = kAudioUnitType_FormatConverter,
        .componentSubType = kAudioUnitSubType_AUConverter, .componentManufacturer = kAudioUnitManufacturer_Apple};
    AudioComponent component = AudioComponentFindNext(NULL, &description);
    if (!component) { *error = kAudioUnitErr_InvalidProperty; goto fail; }
#define CHECK(call) do { *error = (call); if (*error != noErr) goto fail; } while (0)
    CHECK(AudioComponentInstanceNew(component, &s->unit));
    AudioStreamBasicDescription input = pcm(inputRate), output = pcm(outputRate);
    CHECK(AudioUnitSetProperty(s->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &input, sizeof(input)));
    CHECK(AudioUnitSetProperty(s->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 0, &output, sizeof(output)));
    UInt32 maxFrames = MAX_OUTPUT_FRAMES;
    CHECK(AudioUnitSetProperty(s->unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, sizeof(maxFrames)));
    AURenderCallbackStruct callback = {supply, s};
    CHECK(AudioUnitSetProperty(s->unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &callback, sizeof(callback)));
    CHECK(AudioUnitInitialize(s->unit));
    return s;
fail:
    sf_resampler_destroy(s); return NULL;
#undef CHECK
}

OSStatus sf_resampler_render(SFResampler *s, UInt32 frames, AudioBufferList *output) {
    if (frames > MAX_OUTPUT_FRAMES) return kAudioUnitErr_TooManyFramesToProcess;
    AudioTimeStamp time = {.mSampleTime = s->sampleTime, .mFlags = kAudioTimeStampSampleTimeValid};
    AudioUnitRenderActionFlags flags = 0;
    OSStatus result = AudioUnitRender(s->unit, &flags, &time, 0, frames, output);
    s->sampleTime += frames;
    return result;
}
