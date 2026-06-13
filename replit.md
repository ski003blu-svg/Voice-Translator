# MissU Live Voice Translation

A real-time Telugu ↔ English voice translation web app. Two users join the same room and hear each other's voices translated live.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/missu run dev` — run the frontend (port assigned by workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind CSS + Agora Web SDK (`agora-rtc-sdk-ng`)
- API: Express 5
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Translation: ElevenLabs Scribe (STT) + MyMemory free API (text translation) + ElevenLabs TTS (speech synthesis)
- Voice calling: Agora RTC Web SDK

## Where things live

- `artifacts/missu/` — React + Vite frontend (Home, Join, Call pages)
- `artifacts/api-server/src/routes/agora.ts` — Agora token generation endpoint
- `artifacts/api-server/src/lib/translation-ws.ts` — WebSocket translation server
- `lib/api-spec/openapi.yaml` — API contract source of truth
- `lib/api-client-react/src/generated/` — generated React Query hooks
- `lib/api-zod/src/generated/` — generated Zod validation schemas

## Architecture decisions

- Agora RTC handles the raw voice call between users (peer-to-peer WebRTC).
- Translation pipeline: browser captures audio → sends to `/ws/translate` WebSocket → server transcribes (Whisper) → translates (GPT-4o-mini) → synthesizes speech (TTS-1) → sends translated audio back to the other user.
- WebSocket path `/ws` is listed in `artifact.toml` so the reverse proxy forwards it correctly.
- Token generation happens server-side to keep `AGORA_APP_CERTIFICATE` private.
- Audio is accumulated for ~1.5s of silence before processing to balance latency and accuracy.

## Product

- **Home** — landing page with tagline and call-to-action
- **Join Call** — enter Room ID, select languages (English / Telugu), click Join
- **Live Call** — active call with Agora voice + optional live translation toggle, animated waveform, status indicator (Listening / Translating / Speaking)

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After editing OpenAPI spec, always re-run `pnpm --filter @workspace/api-spec run codegen` before touching backend routes.
- The WebSocket path `/ws` must stay in `artifact.toml`'s `paths` array — the reverse proxy only forwards listed paths.
- `agora-access-token` npm package is used for secure server-side Agora token generation.

## Required secrets

- `AGORA_APP_ID` — from Agora console
- `AGORA_APP_CERTIFICATE` — from Agora console (never expose to frontend)
- `OPENAI_API_KEY` — for Whisper STT + GPT translation + TTS

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
