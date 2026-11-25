#include "Ring.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#define CAPACITY 16384u
struct SFRing { float l[CAPACITY], r[CAPACITY]; _Atomic uint32_t read, write; _Atomic bool muted; };
SFRing *sf_ring_create(void) { return calloc(1, sizeof(SFRing)); }
void sf_ring_destroy(SFRing *s) { free(s); }
void sf_ring_mute(SFRing *s, bool m) { atomic_store(&s->muted, m); }
void sf_ring_write(SFRing *s,const float *l,const float *r,uint32_t n) {
 uint32_t w=atomic_load_explicit(&s->write,memory_order_relaxed), rd=atomic_load_explicit(&s->read,memory_order_acquire);
 uint32_t freeFrames=CAPACITY-(w-rd); if(n>freeFrames) n=freeFrames;
 for(uint32_t i=0;i<n;i++){s->l[(w+i)%CAPACITY]=l[i];s->r[(w+i)%CAPACITY]=r?r[i]:l[i];}
 atomic_store_explicit(&s->write,w+n,memory_order_release);
}
void sf_ring_read(SFRing *s,float *l,float *r,uint32_t n) {
 uint32_t rd=atomic_load_explicit(&s->read,memory_order_relaxed), w=atomic_load_explicit(&s->write,memory_order_acquire);
 bool muted=atomic_load(&s->muted); uint32_t available=w-rd;
 // Bounded latency after a stalled client; discard old samples instead of replaying speech.
 if(available>4096){rd=w-4096;available=4096;}
 for(uint32_t i=0;i<n;i++){bool has=i<available;l[i]=has&&!muted?s->l[(rd+i)%CAPACITY]:0;if(r)r[i]=has&&!muted?s->r[(rd+i)%CAPACITY]:0;}
 atomic_store_explicit(&s->read,rd+(n<available?n:available),memory_order_release);
}
