![Downbeat banner](docs/assets/banner.svg)

# Downbeat – one song on every phone in the room

[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20Durable%20Objects-F38020?style=flat&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/durable-objects/) [![Swift](https://img.shields.io/badge/CLI-Swift%206-F05138?style=flat&logo=swift&logoColor=white)](cli/) [![Platform](https://img.shields.io/badge/Host-macOS%2015%2B-000000?style=flat&logo=apple&logoColor=white)](docs/SELF-HOSTING.md) [![Web](https://img.shields.io/badge/Listeners-any%20browser-3ef2a0?style=flat)](docs/ARCHITECTURE.md) [![License](https://img.shields.io/badge/License-MIT-orange?style=flat)](LICENSE)

**Downbeat** plays whatever your Mac is playing on every phone in the room at the same moment. Listeners scan a QR code and tap once, with no app, account or pairing.

---

## Features

- **No app for listeners** a QR code and a six-letter room code open the room in any browser
- **Shared room clock** every device syncs to the Durable Object's time server with min-RTT filtering
- **Drift correction** a small playback-rate nudge keeps devices together over hours
- **Live capture** a Core Audio process tap captures any app on the Mac and mutes the original
- **One native binary** capture, Opus encoding, transport, local playback and dashboard in Swift
- **Realtime-safe playback** decoded audio goes through shared memory straight to the AudioWorklet
- **Self-hosted** one Worker, one Durable Object, R2 and D1 on your own Cloudflare account

---

## Quick start

```bash
git clone https://github.com/luka-loehr/downbeat && cd downbeat
./scripts/install.sh
export DOWNBEAT_URL=https://downbeat.example.com   # your own deployment
downbeat login
downbeat host
```

Deploy the server first, see [Self-hosting](docs/SELF-HOSTING.md).

---

## Documentation

- [Self-hosting](docs/SELF-HOSTING.md) – deploy the Worker, configure the CLI, hosting options, development
- [Architecture](docs/ARCHITECTURE.md) – system design, clock synchronization, measurements, design choices
- [Changelog](CHANGELOG.md)

---

## License

MIT License - [View License](LICENSE)  
Downbeat plays audio you provide or that your own machine is already playing; it ships no content.

---

## Support

- [Report bugs](https://github.com/luka-loehr/downbeat/issues)  
- [luka@lukaloehr.com](mailto:luka@lukaloehr.com)  

---

Developed by [Luka Löhr](https://github.com/luka-loehr)
