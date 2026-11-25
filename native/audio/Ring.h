#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef struct SFRing SFRing;
SFRing *sf_ring_create(void);
void sf_ring_destroy(SFRing *ring);
void sf_ring_write(SFRing *ring, const float *left, const float *right, uint32_t count);
void sf_ring_read(SFRing *ring, float *left, float *right, uint32_t count);
void sf_ring_mute(SFRing *ring, bool muted);
