#!/usr/bin/env bash
# ============================================================================
# BaixaAiRESOLVE — baixa os binarios de runtime para macOS (deno, yt-dlp, ffmpeg)
# Uso:   ./fetch-mac-bins.sh [x64|arm64]
# Deve ser executado EM UM MAC antes do `pnpm dist:mac` (os binarios sao nativos).
# ============================================================================
set -euo pipefail

ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  x86_64|x64)    DENO_ARCH="x86_64-apple-darwin"; FF_ARCH="x86_64" ;;
  arm64|aarch64) DENO_ARCH="aarch64-apple-darwin"; FF_ARCH="arm64" ;;
  *) echo "Arquitetura desconhecida: $ARCH"; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$BIN"

echo "==> Baixando deno ($DENO_ARCH)"
curl -fL "https://github.com/denoland/deno/releases/latest/download/deno-${DENO_ARCH}.zip" -o "$TMP/deno.zip"
unzip -o "$TMP/deno.zip" -d "$BIN" >/dev/null
chmod +x "$BIN/deno"

echo "==> Baixando yt-dlp (universal)"
curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" -o "$BIN/yt-dlp"
chmod +x "$BIN/yt-dlp"

echo "==> Baixando ffmpeg ($FF_ARCH)"
# ffmpeg estatico. Override: export FFMPEG_URL="..." antes de rodar.
if [[ -n "${FFMPEG_URL:-}" ]]; then
  curl -fL "$FFMPEG_URL" -o "$TMP/ffmpeg.zip"
else
  case "$ARCH" in
    x86_64|x64)
      # evermeet.cx fornece build estatico x86_64 (zip com o binario 'ffmpeg' na raiz)
      curl -fL "https://evermeet.cx/ffmpeg/getrelease/zip" -o "$TMP/ffmpeg.zip" ;;
    arm64|aarch64)
      # osxexperts.net fornece build arm64 (dmg). Fallback documentado no README.
      curl -fL "https://www.osxexperts.net/ffmpeg7arm.zip" -o "$TMP/ffmpeg.zip" ;;
  esac
fi
unzip -o "$TMP/ffmpeg.zip" -d "$TMP/ffmpeg" >/dev/null 2>&1 || true
FF_BIN="$(find "$TMP/ffmpeg" "$BIN" -maxdepth 2 -name 'ffmpeg' -type f 2>/dev/null | head -n1)"
if [[ -z "$FF_BIN" ]]; then
  echo "!! Nao foi possivel extrair o ffmpeg automaticamente."
  echo "   Instale via Homebrew e copie:  brew install ffmpeg && cp \"\$(brew --prefix ffmpeg)/bin/ffmpeg\" \"$BIN/ffmpeg\""
  exit 1
fi
cp "$FF_BIN" "$BIN/ffmpeg"
chmod +x "$BIN/ffmpeg"

# ffprobe (opcional, usado apenas como fallback do downloader)
if [[ -n "${FFPROBE_URL:-}" ]]; then
  curl -fL "$FFPROBE_URL" -o "$BIN/ffprobe" && chmod +x "$BIN/ffprobe" || true
fi

echo "==> Concluido. Binarios em $BIN:"
ls -la "$BIN"
