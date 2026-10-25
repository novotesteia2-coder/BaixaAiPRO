#!/usr/bin/env bash
# BaixaAiPRO - baixa os binarios de runtime para macOS (deno, yt-dlp, ffmpeg)
# Uso: ./fetch-mac-bins.sh [x64|arm64]
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
FF_OK=0
if [[ -n "${FFMPEG_URL:-}" ]]; then
  if curl -fL "$FFMPEG_URL" -o "$TMP/ffmpeg.zip"; then FF_OK=1; fi
else
  if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
    if curl -fL "https://www.osxexperts.net/ffmpeg7arm.zip" -o "$TMP/ffmpeg.zip"; then FF_OK=1; fi
  else
    for u in "https://www.osxexperts.net/ffmpeg7x64.zip" "https://evermeet.cx/ffmpeg/getrelease/zip"; do
      if curl -fL "$u" -o "$TMP/ffmpeg.zip"; then FF_OK=1; break; fi
    done
  fi
fi

if [[ "$FF_OK" == "1" ]]; then
  unzip -o "$TMP/ffmpeg.zip" -d "$TMP/ffmpeg" >/dev/null 2>&1 || true
  FF_BIN="$(find "$TMP/ffmpeg" "$BIN" -maxdepth 2 -name 'ffmpeg' -type f 2>/dev/null | head -n1)"
  if [[ -n "$FF_BIN" ]]; then
    cp "$FF_BIN" "$BIN/ffmpeg"
    chmod +x "$BIN/ffmpeg"
  else
    FF_OK=0
  fi
fi

if [[ "$FF_OK" != "1" ]]; then
  echo "!! AVISO: ffmpeg nao foi baixado automaticamente (segue sem ffmpeg)."
fi

echo "==> Concluido. Binarios em $BIN:"
ls -la "$BIN"
