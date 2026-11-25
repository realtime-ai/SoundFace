#pragma once
#include <AudioToolbox/AudioToolbox.h>
#include "Ring.h"

typedef struct SFResampler SFResampler;
// Created/initialized before device callbacks start. Owns no device or ring.
SFResampler *sf_resampler_create(SFRing *ring, double inputRate, double outputRate, OSStatus *error);
OSStatus sf_resampler_render(SFResampler *resampler, UInt32 frames, AudioBufferList *output);
void sf_resampler_destroy(SFResampler *resampler);
