# DynamicTV

A small Docker service that turns your HDHomeRun into a web TV you can watch from any browser
on your network, with playback kept in sync across every device.

- **One shared stream.** The server tunes one channel at a time; every device watches the same one.
  Pick a channel on your phone and the TV, laptop, and tablet switch too.
- **Synchronized playback.** Each device plays at the same wall-clock position
  (a fixed few seconds behind the encoder), so you can walk from the living room to the kitchen,
  open the page there, and be at the same moment in the show. Devices drift by well under a second.
- **Plays anywhere.** Broadcast MPEG-2 / AC-3 is transcoded once to H.264 / AAC HLS, which works in
  Safari (iPhone, iPad, Mac), Chrome, Edge, Firefox and Android.
- **Accounts and chat.** A login protects everything (video, API, WebSocket). The first visit creates
  the admin account, who then adds everyone else. A chat tab shows who is watching and attributes
  channel changes to the person who made them.
- **Nothing hits the disk** except accounts and chat history in `/data`. Segments live in a RAM tmpfs
  and roll off after a minute.

## Quick start

You need Docker (Docker Desktop is fine) on a machine on the same LAN as the HDHomeRun.

```bash
cp .env.example .env
```

Edit `.env` and set `HDHR_HOST` to the tuner's IP (find it in the HDHomeRun app or at
`http://my.hdhomerun.com`). Then:

```bash
docker compose up -d --build
```

Open `http://<server-ip>:8080`. The first visit asks you to create the admin account; do this before
exposing the server to the internet, since the setup page is open until an admin exists. Then pick a
channel. Tuning takes about six seconds the first time, and everyone who opens the page afterwards
joins at the shared position.

To see it work without a tuner, set `DEMO_CHANNEL=1` and pick "Test pattern".

### Pre-built image

Every push to `main` builds `ghcr.io/dynamicmeme/dynamictv:latest` (amd64 and arm64) via GitHub
Actions. Use it instead of building locally:

```bash
docker run -d --name dynamictv --init --restart unless-stopped \
  -p 8080:8080 -e HDHR_HOST=192.168.1.50 \
  --tmpfs /tmp/hls:size=256m ghcr.io/dynamicmeme/dynamictv:latest
```

## Unraid

1. On GitHub, wait for the "Build and publish image" action to finish, then make sure the package
   is public: repo page, **Packages**, `dynamictv`, **Package settings**, **Change visibility**.
   (Unraid can only pull public images without a registry login.)
2. Copy [`unraid/DynamicTV.xml`](unraid/DynamicTV.xml) onto the Unraid flash drive at
   `/boot/config/plugins/dockerMan/templates-user/my-DynamicTV.xml`. The `flash` SMB share
   exposes that path as `config\plugins\dockerMan\templates-user`.
3. In the Unraid web UI open **Docker**, click **Add Container**, and choose **DynamicTV** from
   the **Template** dropdown (under "User templates").
4. Fill in **HDHomeRun IP**, adjust the port if 8080 is taken, leave the data path at
   `/mnt/user/appdata/dynamictv`, and click **Apply**.
5. Click the container icon and choose **WebUI**, then create the admin account.

Without the template, the same thing by hand in **Add Container**: Repository
`ghcr.io/dynamicmeme/dynamictv:latest`, a port mapping for 8080, a path mapping from
`/mnt/user/appdata/dynamictv` to `/data`, a variable `HDHR_HOST`, and
`--init --tmpfs /tmp/hls:size=256m` in **Extra Parameters** (Advanced View).

For Intel/AMD hardware encoding on Unraid, click **Add another Path, Port, Variable, Label or
Device** in the container settings, choose **Device** with value `/dev/dri`, and fill in the VAAPI
line from the hardware encoding section below in the ffmpeg override field. Unraid's Intel GPU TOP
plugin loads the `i915` driver needed for that. (The template deliberately has no blank device
entry: Unraid passes an empty `--device=''`, which Docker rejects.)

## Configuration

All settings are environment variables (see `docker-compose.yml` / `.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `HDHR_HOST` | (auto) | IP/hostname of the HDHomeRun. Empty uses SiliconDust's online discovery, which needs internet access and finds tuners behind the same public IP. |
| `VIDEO_HEIGHT` | `720` | Output height. `1080` for full quality (about 2x the CPU), `480` for weak hardware, `0` to keep the source resolution. |
| `VIDEO_BITRATE` | `4000k` | Maximum video bitrate. CRF encoding stays below this cap. |
| `X264_PRESET` | `veryfast` | libx264 speed/quality trade-off. `superfast` or `ultrafast` if CPU is tight. |
| `X264_CRF` | `23` | Quality target; lower is better and bigger. |
| `AUDIO_BITRATE` | `128k` | Stereo AAC bitrate. |
| `TARGET_LATENCY` | `6` | Seconds behind the encoder clock that every device plays. Keep it at least `SEGMENT_SECONDS * 2 + 1`. Raise it on flaky Wi-Fi. |
| `SEGMENT_SECONDS` | `2` | HLS segment length. |
| `HLS_LIST_SIZE` | `30` | Segments kept in the playlist (the rewind window is `SEGMENT_SECONDS * HLS_LIST_SIZE`). |
| `AUTO_TUNE` | | Channel number to tune when the container starts, e.g. `5.1`. |
| `DEMO_CHANNEL` | `0` | `1` adds a built-in test pattern channel. |
| `FFMPEG_VIDEO_ARGS` | | Replaces the whole software video encoder chain (see hardware encoding). |
| `LOG_FFMPEG_ARGS` | | Set to `1` to log the exact ffmpeg command line. |
| `DATA_DIR` | `/data` | Accounts, session secret and chat history. Mount it or they are lost on restart. |
| `SESSION_DAYS` | `30` | How long a login lasts. |
| `CHAT_HISTORY` | `300` | Messages kept. |
| `TRUST_PROXY` | private networks | Express `trust proxy` setting, so `req.ip` and HTTPS detection are right behind a reverse proxy. |
| `PORT` | `8080` | Listening port inside the container. |

### CPU usage

Software encoding of a 1080i broadcast to 720p H.264 with `veryfast` takes roughly two to three
cores of a modern desktop CPU, or most of a small NAS. Only one encode runs no matter how many
devices are watching. Drop `VIDEO_HEIGHT` or use `X264_PRESET=superfast` if the status bar shows
"encoder lagging".

### Hardware encoding

`FFMPEG_VIDEO_ARGS` replaces the `-vf … -c:v libx264 …` part of the ffmpeg command. Everything
else (input, audio, HLS output, keyframe placement) stays the same.

**Intel / AMD iGPU (VAAPI).** Uncomment the `/dev/dri` device in `docker-compose.yml`, then:

```
FFMPEG_VIDEO_ARGS=-vaapi_device /dev/dri/renderD128 -vf yadif=mode=send_frame:deint=interlaced,format=nv12,hwupload,scale_vaapi=w=-2:h=720 -c:v h264_vaapi -qp 24 -maxrate 4000k -bufsize 8000k
```

**NVIDIA (NVENC).** Use `runtime: nvidia` (or `gpus: all`) in the compose file and:

```
FFMPEG_VIDEO_ARGS=-vf yadif=mode=send_frame:deint=interlaced,scale=-2:720 -c:v h264_nvenc -preset p4 -cq 24 -maxrate 4000k -bufsize 8000k -pix_fmt yuv420p
```

If the Debian ffmpeg in the image lacks a given encoder, swap the base image for one with a fuller
ffmpeg build (for example `linuxserver/ffmpeg` or `jrottenberg/ffmpeg`) and install Node on top.

## How the sync works

1. ffmpeg writes HLS segments with `EXT-X-PROGRAM-DATE-TIME` tags, so every position in the
   stream has a wall-clock timestamp from the server's clock.
2. Each browser measures its clock offset to the server over the WebSocket (NTP-style, best of the
   lowest-RTT samples).
3. Every 500 ms the player computes where `server time - TARGET_LATENCY` falls in the stream.
   If it is more than 2.5 s off it seeks; otherwise it nudges `playbackRate` between 0.9x and 1.1x
   until the error is inside a 0.1 s dead band. The status line under the video shows the offset.
4. A channel change starts a fresh ffmpeg run with a new stream id. The server broadcasts the
   state, and every device reloads the new playlist. A device that joins in the first few seconds
   pauses on "waiting for sync point" until the shared timeline reaches the stream's first segment.

Because the reference is the server clock, devices do not need to talk to each other.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/channels` | Lineup from the HDHomeRun (`?refresh=1` bypasses the cache). |
| `GET` | `/api/state` | Current channel, stream id, status, target latency, server time. |
| `POST` | `/api/tune` | Body `{"channel": "5.1"}`. Switches every device. |
| `POST` | `/api/stop` | Stops the stream. |
| `GET` | `/hls/<streamId>/stream.m3u8` | The live playlist (usable in VLC or any HLS player). |
| `WS` | `/ws` | State pushes, `{"type":"tune","channel":"5.1"}`, `{"type":"ping","clientTime":…}`. |

## Troubleshooting

- **"Stream failed… Server returned 503"** means every tuner on the HDHomeRun is busy
  (another app or a DVR recording). The server retries with backoff.
- **No lineup / "No HDHomeRun found"**: set `HDHR_HOST` explicitly. Broadcast discovery does not
  work from inside a container.
- **Video shows a "Tap to play" button**: browsers block unmuted autoplay until you interact with
  the page. After the first tap, channel changes play automatically.
- **Status says "encoder lagging"**: the CPU cannot keep up. Lower `VIDEO_HEIGHT`, use a faster
  preset, or enable hardware encoding.
- **Choppy on Wi-Fi**: raise `TARGET_LATENCY` to 8 or 10 for more buffer.

## Limitations

- One channel at a time. Watching two different channels on two devices is not supported by design;
  that would need one ffmpeg process per channel and per-device sessions.
- No recording or guide data. The playlist keeps about a minute of rewind.
- No authentication. Keep it on your LAN or behind a reverse proxy that adds auth.
