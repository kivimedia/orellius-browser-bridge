#!/usr/bin/env bash
# Verify the BI Pixie isolated-mode MP4 with ffprobe + CutSense dedup.
set -e
MP4="C:/Users/raviv/datachant/bipixie-walkthrough/output/bipixie-walkthrough-v3-iso.mp4"
echo "== ffprobe =="
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate,nb_frames "$MP4"
ls -la "$MP4"
echo ""
echo "== CutSense (dedup signal) =="
cd "E:/FromC/projects/CutSense"
node packages/cli/bin/cutsense.js run "$MP4" --prompt "describe scenes briefly" 2>&1 | tail -8
