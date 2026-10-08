<p align="center">
  <img src="./public/folio-logo.svg" alt="Folio Logo" width="72" height="72" />
</p>

<h1 align="center">Folio</h1>

<p align="center">
  <strong>A high-performance, privacy-first bookmark engine with local vector search and Gemini AI enrichment.</strong>
</p>

<p align="center">
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-v2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri v2" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://sqlite.org/"><img src="https://img.shields.io/badge/SQLite-Local--First-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite" /></a>
  <a href="https://orm.drizzle.team/"><img src="https://img.shields.io/badge/Drizzle-ORM-C5F74F?style=flat-square&logoColor=black" alt="Drizzle ORM" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind-CSS-38B2AC?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" /></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/Google-Gemini_AI-8E75B2?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini AI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <img src="./docs/screenshot.png" alt="Folio Screenshot" width="100%" />
</p>

---

## Overview

**Folio** is a desktop application designed to organize, enrich, and search through thousands of bookmarks without surrendering privacy. Built on **Tauri v2**, **React 19**, and an embedded **SQLite** database, Folio keeps all data locally on your device while optionally leveraging **Google Gemini** for intelligent classification, summaries, and vector embeddings.

---

## Key Features

- **Local-First & Private** — All bookmarks, folders, and vector embeddings are stored locally in SQLite via Drizzle ORM. Zero telemetry.
- **Hybrid Search** — Instant full-text keyword filtering combined with cosine-similarity vector search powered by `text-embedding-004`.
- **AI Enrichment** — Automated categorization, concise summaries, topic tags, and tech-stack detection using Gemini models with rate-limit resilient background queueing.
- **Smart Deduplication** — Canonical URL normalization that strips tracking parameters (`utm_*`, referral tokens) and identifies duplicate bookmarks for easy cleanup.
- **High-Speed Importer & Exporter** — Parses Netscape Bookmark HTML files from Chrome, Safari, Firefox, Arc, and Edge (1,500+ items in <200ms) with full hierarchy preservation and HTML export.
- **Refined UX** — Dark, light, and system themes, responsive grid/list layouts, folder tree navigation, and keyboard-first design.

---

## Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Desktop Runtime** | [Tauri v2](https://tauri.app/) (Rust backend, native OS webview) |
| **Frontend** | [React 19](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vitejs.dev/) |
| **Styling & UI** | [Tailwind CSS](https://tailwindcss.com/), [Radix UI](https://www.radix-ui.com/), [Lucide Icons](https://lucide.dev/), [Sonner](https://sonner.emilkowal.ski/) |
| **State & Cache** | [TanStack Query](https://tanstack.com/query) |
| **Storage & ORM** | [SQLite](https://sqlite.org/) via `@tauri-apps/plugin-sql` & [Drizzle ORM](https://orm.drizzle.team/) |
| **AI & Embeddings** | [Google Gen AI SDK](https://github.com/google-gemini/generative-ai-js) (`@google/genai`) |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+) and [pnpm](https://pnpm.io/)
- [Rust toolchain](https://www.rust-lang.org/tools/install) (required for building Tauri apps)

### Installation

```bash
# Clone repository
git clone https://github.com/NickM101/bookmark-engine.git
cd bookmark-engine

# Install frontend dependencies
pnpm install
```

### Development

```bash
# Run web preview only
pnpm dev

# Run desktop application with Tauri
pnpm tauri dev
```

### Production Build

```bash
# Build desktop executable and installers
pnpm tauri build
```

---

## Configuration

Folio works out-of-the-box as a local bookmark manager. To enable AI categorization and semantic search:

1. Open **Settings** (`⌘` / `Ctrl` + `,` or the settings icon in the top right).
2. Enter your **Gemini API Key** (obtainable free from [Google AI Studio](https://aistudio.google.com/)).
3. Keys are stored locally on your machine and never sent anywhere except the official Google Gemini API endpoint.

---

## Testing

```bash
pnpm test
```

---

## License

Distributed under the [MIT](LICENSE) License.
