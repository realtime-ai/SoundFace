#include "../native/audio/Resampler.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct { UInt32 mNumberBuffers; AudioBuffer mBuffers[2]; } StereoBuffers;
static double phase;
static void feed(SFRing *ring, double rate, unsigned frames) {
    float input[4096];
    assert(frames <= 4096);
    for (unsigned i = 0; i < frames; i++) { input[i] = 0.25f * sin(phase); phase += 2 * M_PI * 1000 / rate; }
    sf_ring_write(ring, input, NULL, frames);
}
static void test_rate(double rate) {
    phase = 0;
    SFRing *ring = sf_ring_create();
    OSStatus error = 0;
    SFResampler *s = sf_resampler_create(ring, rate, 48000, &error);
    assert(s && error == noErr);
    float left[960], right[960];
    StereoBuffers buffers = {2, {{1, sizeof(left), left}, {1, sizeof(right), right}}};
    // Preserve continuous input across irregular output blocks and conversion ratios.
    feed(ring, rate, (unsigned)(rate * 0.06));
    unsigned outputFrames = 0, supplied = 0, measured = 0, crossings = 0;
    float previous = 0;
    double energy = 0;
    unsigned chunks[] = {128, 480, 960, 256};
    for (unsigned i = 0; outputFrames < 96000; i++) {
        unsigned frames = chunks[i % 4];
        if (frames > 96000 - outputFrames) frames = 96000 - outputFrames;
        unsigned needed = (unsigned)ceil((outputFrames + frames) * rate / 48000);
        feed(ring, rate, needed - supplied); supplied = needed;
        for (unsigned c = 0; c < 2; c++) buffers.mBuffers[c].mDataByteSize = frames * sizeof(float);
        assert(sf_resampler_render(s, frames, (AudioBufferList *)&buffers) == noErr);
        for (unsigned n = 0; n < frames; n++) {
            assert(isfinite(left[n]) && fabsf(left[n]) < 0.3f);
            assert(fabsf(left[n] - right[n]) < 0.00001f);
            if (outputFrames + n >= 4800) {
                if (previous <= 0 && left[n] > 0) crossings++;
                energy += left[n] * left[n]; measured++;
            }
            previous = left[n];
        }
        outputFrames += frames;
    }
    double hz = crossings * 48000.0 / measured, rms = sqrt(energy / measured);
    assert(fabs(hz - 1000) < 5 && rms > 0.16 && rms < 0.19);
    // No stale speech after the ring is muted and converter history has drained.
    sf_ring_mute(ring, true);
    for (unsigned i = 0; i < 20; i++) {
        feed(ring, rate, (unsigned)(rate / 50));
        for (unsigned c = 0; c < 2; c++) buffers.mBuffers[c].mDataByteSize = sizeof(left);
        assert(sf_resampler_render(s, 960, (AudioBufferList *)&buffers) == noErr);
    }
    for (unsigned i = 0; i < 960; i++) assert(left[i] == 0 && right[i] == 0);
    assert(sf_resampler_render(s, 8193, (AudioBufferList *)&buffers) == kAudioUnitErr_TooManyFramesToProcess);
    sf_resampler_destroy(s); sf_ring_destroy(ring);
    printf("PASS %.0f -> 48000 Hz: 2 s, mono/stereo, irregular blocks, %.1f Hz tone, mute, frame bounds\n", rate, hz);
}
int main(void) { test_rate(8000); test_rate(16000); test_rate(24000); test_rate(32000); return 0; }
