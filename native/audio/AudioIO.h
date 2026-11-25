#pragma once
#include <CoreAudio/CoreAudio.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef struct SFRoute SFRoute;
typedef struct {
    uint64_t capturedFrames, outputFrames;
    float inputPeak, outputPeak;
    double sampleRate, inputSampleRate;
    int32_t error;
} SFRouteStats;
SFRoute *sf_route_start(AudioDeviceID input, AudioDeviceID output, char *error, size_t capacity);
void sf_route_stop(SFRoute *route);
void sf_route_mute(SFRoute *route, bool muted);
SFRouteStats sf_route_stats(SFRoute *route);
