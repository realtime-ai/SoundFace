#include "../native/audio/Ring.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
 SFRing *s=sf_ring_create(); assert(s);
 float l[20000],r[20000],out[20000],right[20000];
 for(int i=0;i<20000;i++){l[i]=(float)i+1;r[i]=-(float)i-1;}
 sf_ring_read(s,out,right,100); for(int i=0;i<100;i++)assert(out[i]==0&&right[i]==0);
 sf_ring_write(s,l,r,100); sf_ring_read(s,out,right,120);
 for(int i=0;i<120;i++){assert(out[i]==(i<100?l[i]:0));assert(right[i]==(i<100?r[i]:0));}
 sf_ring_write(s,l,0,50); sf_ring_read(s,out,right,50);for(int i=0;i<50;i++)assert(out[i]==right[i]&&out[i]==l[i]);
 sf_ring_mute(s,true);sf_ring_write(s,l,r,100);sf_ring_read(s,out,right,100);for(int i=0;i<100;i++)assert(out[i]==0&&right[i]==0);
 sf_ring_mute(s,false);sf_ring_read(s,out,right,100);for(int i=0;i<100;i++)assert(out[i]==0&&right[i]==0);
 // Wrap both indexes many times; verify order and independent stereo channels.
 for(int j=0;j<500;j++){sf_ring_write(s,l,r,257);sf_ring_read(s,out,right,257);for(int i=0;i<257;i++){assert(out[i]==l[i]);assert(right[i]==r[i]);}}
 // Full ring drops excess input, reader bounds retained backlog to 4096 frames.
 sf_ring_write(s,l,r,20000);sf_ring_read(s,out,right,5000);
 for(int i=0;i<5000;i++){assert(out[i]==(i<4096?l[12288+i]:0));assert(right[i]==(i<4096?r[12288+i]:0));}
 sf_ring_destroy(s); puts("PASS ring: stereo/mono, underrun, mute drain, wrap, overflow and backlog bound");
}
