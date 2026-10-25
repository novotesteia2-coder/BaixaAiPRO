import { initSync, recognizeBytes } from "./shazamio_core.js";
const __metaUrl = import.meta.url;


// Inicializa o motor WebAssembly do Shazam localmente
const wasmUrl = new URL("./shazamio_core_bg.wasm", __metaUrl);
const wasmBytes = Deno.readFileSync(wasmUrl);
initSync(wasmBytes);

const USER_AGENTS = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Shazam/16.2.0 (iPhone; iOS 17.4; Scale/3.00)",
    "Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Build/TQ3A.230805.001)"
];

function uuidv4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    }).toUpperCase();
}

async function queryShazamSignature(sig, language = "pt-BR") {
    const endpoint = `https://amp.shazam.com/discovery/v5/${language}/BR/iphone/-/tag/${uuidv4()}/${uuidv4()}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3`;
    const payload = {
        timezone: "America/Sao_Paulo",
        signature: {
            uri: sig.uri,
            samplems: sig.samplems
        },
        timestamp: Date.now(),
        context: {},
        geolocation: {}
    };

    const headers = {
        "X-Shazam-Platform": "IPHONE",
        "X-Shazam-AppVersion": "14.1.0",
        "Accept": "*/*",
        "Content-Type": "application/json",
        "Accept-Language": language,
        "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    };

    const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !data.matches || data.matches.length === 0 || !data.track) {
        return null;
    }
    return data;
}

async function buscarLinkYouTube(artist, title, shazamTrack) {
    // 1. Tenta verificar se o prÃ³prio Shazam forneceu o link direto do vÃ­deo no YouTube
    try {
        const videoSection = (shazamTrack.sections || []).find((s) => s.type === "VIDEO");
        if (videoSection && videoSection.youtubeurl) {
            const ytResp = await fetch(videoSection.youtubeurl, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            });
            if (ytResp.ok) {
                const ytJson = await ytResp.json();
                const actions = ytJson?.actions || [];
                for (const act of actions) {
                    if (act.uri && (act.uri.includes("youtube.com") || act.uri.includes("youtu.be"))) {
                        const clean = normalizarUrlYouTube(act.uri);
                        if (clean) return clean;
                    }
                }
            }
        }
    } catch (_) {
        // Segue para busca direta no YouTube
    }

    // 2. Busca direta na pÃ¡gina de resultados do YouTube (ultra-rÃ¡pida ~200ms)
    try {
        const query = `${artist} - ${title}`;
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=pt`;
        const resp = await fetch(searchUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8"
            }
        });
        if (resp.ok) {
            const html = await resp.text();
            const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
            if (match && match[1]) {
                return {
                    url: `https://www.youtube.com/watch?v=${match[1]}`,
                    videoId: match[1]
                };
            }
        }
    } catch (_) {
        // Ignora erro e usa URL de busca como fallback
    }

    return {
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(artist + " " + title)}`,
        videoId: null
    };
}

function normalizarUrlYouTube(rawUri) {
    try {
        const u = new URL(rawUri);
        const v = u.searchParams.get("v") || (u.hostname.includes("youtu.be") ? u.pathname.replace("/", "") : null);
        if (v && v.length === 11) {
            return {
                url: `https://www.youtube.com/watch?v=${v}`,
                videoId: v
            };
        }
    } catch (_) {}
    return null;
}

async function extrairTrechoWav(ffmpegPath, mediaPath, startSec, durationSec, tempWavPath) {
    const start = Math.max(0, startSec).toFixed(2);
    const cmd = new Deno.Command(ffmpegPath, {
        args: [
            "-y",
            "-ss", String(start),
            "-t", String(durationSec),
            "-i", mediaPath,
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-f", "wav",
            tempWavPath
        ],
        stdout: "null",
        stderr: "piped"
    });
    const out = await cmd.output();
    return out.success;
}

async function tentarReconhecerWav(wavPath) {
    const bytes = Deno.readFileSync(wavPath);
    const signatures = recognizeBytes(bytes, 0, Number.MAX_SAFE_INTEGER);
    if (!signatures || signatures.length === 0) {
        return null;
    }

    // Ordena Ã­ndices para testar primeiro o meio/inÃ­cio do trecho (onde a agulha estÃ¡)
    const indicesToTry = [];
    const total = signatures.length;
    const mid = Math.floor(total / 3);
    indicesToTry.push(mid);
    if (0 !== mid) indicesToTry.push(0);
    for (let i = 0; i < total; i += 2) {
        if (!indicesToTry.includes(i)) indicesToTry.push(i);
    }

    let matchData = null;
    for (const idx of indicesToTry.slice(0, 5)) {
        const sig = signatures[idx];
        if (!sig) continue;
        try {
            const res = await queryShazamSignature(sig, "pt-BR");
            if (res && res.track) {
                matchData = res;
                break;
            }
        } catch (_) {}
    }

    for (const sig of signatures) {
        try { sig.free(); } catch (_) {}
    }

    return matchData;
}

const SEP = Deno.build.os === "windows" ? "\\" : "/";

function gravarJsonSeguro(caminho, dados) {
    const jsonAscii = JSON.stringify(dados).replace(/[\u007F-\uFFFF]/g, (ch) => {
        return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
    });
    Deno.writeTextFileSync(caminho, jsonAscii);
}

async function main() {
    const reqFile = Deno.args[0];
    const outFile = Deno.args[1];

    if (!reqFile || !outFile) {
        console.error("Uso: deno run -A recognize.mjs <request.json> <output.json>");
        Deno.exit(1);
    }

    try {
        const rawReq = Deno.readTextFileSync(reqFile).replace(/^\uFEFF/, "");
        const req = JSON.parse(rawReq);
        const ffmpegPath = req.ffmpegPath;
        const tempDir = req.tempDir;
        const candidates = req.candidates || [];

        if (!candidates.length) {
            gravarJsonSeguro(outFile, {
                status: "NO_CLIPS",
                message: "Nenhum clipe de Ã¡udio ou vÃ­deo encontrado na posiÃ§Ã£o da agulha na Timeline."
            });
            Deno.exit(0);
        }

        // Remove duplicatas de mesmo arquivo e mesmo segundo (ex: V1 e A1 vinculados)
        const vistos = new Set();
        const unicos = [];
        for (const c of candidates) {
            if (!c.mediaPath) continue;
            const chave = `${c.mediaPath.toLowerCase()}@${Math.round(c.startOffset || 0)}`;
            if (!vistos.has(chave)) {
                vistos.add(chave);
                unicos.push(c);
            }
        }

        for (let i = 0; i < unicos.length; i++) {
            const cand = unicos[i];
            const tempWav = `${tempDir}${SEP}shazam_slice_${Date.now()}_${i}.wav`;

            try {
                // Tenta uma janela de 14 segundos ao redor da agulha
                const offsetInicial = Math.max(0, (cand.startOffset || 0) - 0.5);
                const ok = await extrairTrechoWav(ffmpegPath, cand.mediaPath, offsetInicial, 14, tempWav);

                if (ok) {
                    const shazamRes = await tentarReconhecerWav(tempWav);
                    try { Deno.removeSync(tempWav); } catch (_) {}

                    if (shazamRes && shazamRes.track) {
                        const track = shazamRes.track;
                        const title = track.title || "MÃºsica Desconhecida";
                        const artist = track.subtitle || "Artista Desconhecido";

                        const songSection = (track.sections || []).find((s) => s.type === "SONG");
                        const metadata = songSection?.metadata || [];
                        const album = metadata.find((m) => m.title === "Album" || m.title === "Ãlbum")?.text || "";
                        const year = metadata.find((m) => m.title === "Released" || m.title === "LanÃ§amento")?.text || "";
                        const genre = track.genres?.primary || "";

                        const cover = track.images?.coverarthq || track.images?.coverart || track.images?.background || "";
                        const shazamUrl = track.url || "";

                        let previewUrl = "";
                        const hubActions = track.hub?.actions || [];
                        for (const act of hubActions) {
                            if (act.type === "uri" && act.uri && (act.uri.endsWith(".m4a") || act.uri.includes("mzstatic.com"))) {
                                previewUrl = act.uri;
                                break;
                            }
                        }

                        const ytInfo = await buscarLinkYouTube(artist, title, track);
                        const ytThumb = ytInfo.videoId
                            ? `https://i.ytimg.com/vi/${ytInfo.videoId}/hqdefault.jpg`
                            : "";

                        const finalResult = {
                            status: "MATCH",
                            title,
                            artist,
                            album,
                            year,
                            genre,
                            cover: cover || ytThumb,
                            youtubeThumb: ytThumb,
                            youtubeUrl: ytInfo.url,
                            youtubeVideoId: ytInfo.videoId,
                            shazamUrl,
                            previewUrl,
                            clipName: cand.clipName || "",
                            trackName: cand.trackName || "",
                            timelineTimecode: req.playheadFormatted || ""
                        };

                        gravarJsonSeguro(outFile, finalResult);
                        Deno.exit(0);
                    }
                }
            } catch (_) {
                try { Deno.removeSync(tempWav); } catch (__) {}
            }
        }

        // Se nenhum candidato teve match imediato, tenta deslocar +6 segundos no clipe principal (caso a agulha estivesse num trecho de pausa/fala)
        if (unicos.length > 0) {
            const principal = unicos[0];
            const tempWav2 = `${tempDir}${SEP}shazam_slice_retry_${Date.now()}.wav`;
            try {
                const novoOffset = Math.max(0, (principal.startOffset || 0) + 6);
                const ok2 = await extrairTrechoWav(ffmpegPath, principal.mediaPath, novoOffset, 14, tempWav2);
                if (ok2) {
                    const shazamRes2 = await tentarReconhecerWav(tempWav2);
                    try { Deno.removeSync(tempWav2); } catch (_) {}

                    if (shazamRes2 && shazamRes2.track) {
                        const track = shazamRes2.track;
                        const title = track.title || "MÃºsica Desconhecida";
                        const artist = track.subtitle || "Artista Desconhecido";
                        const songSection = (track.sections || []).find((s) => s.type === "SONG");
                        const metadata = songSection?.metadata || [];
                        const album = metadata.find((m) => m.title === "Album" || m.title === "Ãlbum")?.text || "";
                        const year = metadata.find((m) => m.title === "Released" || m.title === "LanÃ§amento")?.text || "";
                        const genre = track.genres?.primary || "";
                        const cover = track.images?.coverarthq || track.images?.coverart || track.images?.background || "";
                        const shazamUrl = track.url || "";
                        const ytInfo = await buscarLinkYouTube(artist, title, track);
                        const ytThumb = ytInfo.videoId ? `https://i.ytimg.com/vi/${ytInfo.videoId}/hqdefault.jpg` : "";

                        gravarJsonSeguro(outFile, {
                            status: "MATCH",
                            title,
                            artist,
                            album,
                            year,
                            genre,
                            cover: cover || ytThumb,
                            youtubeThumb: ytThumb,
                            youtubeUrl: ytInfo.url,
                            youtubeVideoId: ytInfo.videoId,
                            shazamUrl,
                            clipName: principal.clipName || "",
                            trackName: principal.trackName || "",
                            timelineTimecode: req.playheadFormatted || ""
                        });
                        Deno.exit(0);
                    }
                }
            } catch (_) {
                try { Deno.removeSync(tempWav2); } catch (__) {}
            }
        }

        gravarJsonSeguro(outFile, {
            status: "NO_MATCH",
            message: "NÃ£o foi possÃ­vel identificar uma mÃºsica neste ponto da Timeline. Tente posicionar a agulha onde a mÃºsica esteja mais audÃ­vel."
        });
    } catch (err) {
        gravarJsonSeguro(outFile, {
            status: "ERROR",
            message: String(err?.message || err)
        });
    }
}

main();
