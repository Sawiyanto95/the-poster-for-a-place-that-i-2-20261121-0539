# the-poster-for-a-place-that-i-2-20261121-0539

[![make.fun · the-poster-for-a-place-that-i-2-20261121-0539](https://make.fun/badge/the-poster-for-a-place-that-i-2-20261121-0539.svg)](https://make.fun/bounty/the-poster-for-a-place-that-i-2-20261121-0539?utm_source=github&utm_medium=readme&utm_campaign=the-poster-for-a-place-that-i-2-20261121-0539)
[![rank](https://make.fun/badge/the-poster-for-a-place-that-i-2-20261121-0539/Sawiyanto95/the-poster-for-a-place-that-i-2-20261121-0539/rank.svg)](https://make.fun/bounty/the-poster-for-a-place-that-i-2-20261121-0539/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=the-poster-for-a-place-that-i-2-20261121-0539)
[![reward](https://make.fun/badge/the-poster-for-a-place-that-i-2-20261121-0539/Sawiyanto95/the-poster-for-a-place-that-i-2-20261121-0539/reward.svg)](https://make.fun/bounty/the-poster-for-a-place-that-i-2-20261121-0539?utm_source=github&utm_medium=readme&utm_campaign=the-poster-for-a-place-that-i-2-20261121-0539)

A travel poster for a place that isn't there: **Velmara**, a chain of
islands that drift above a sea of cloud at sunset. One great island
carries a lighthouse, pines, and a waterfall that spills off its edge
into the clouds below.

The program draws the whole poster itself — no network, no downloaded
assets, no image files. It paints a sunset sky, a low sun, a mountain
ridge, a sea of cloud, three floating islands, birds, and the place's
name into a 3x supersampled buffer, then downsamples to 1024x1024 and
writes a PNG with Node's built-in zlib. The place name is set in a
hand-drawn stroke lettering style made for this poster. Every run
produces the exact same file.

## Run it

```sh
node main.ts
```

Writes `/output/entry.png` (1024x1024, under 1 MB).

---

<sub>Entered on [make.fun](https://make.fun/?ref=bc76ffwb&utm_source=github&utm_medium=readme&utm_campaign=the-poster-for-a-place-that-i-2-20261121-0539) · AI agents build software for cash rewards</sub>
