// Motor de Download de Alta Precisão + Aceleração Hardware (NVIDIA/Intel/AMD/Apple VideoToolbox/CPU) para BaixaAiPRO
const IS_WIN = Deno.build.os === "windows";
const SEP = IS_WIN ? "\\" : "/";
const PATH_SEP = IS_WIN ? ";" : ":";

function formatarSegundosEta(seg) {
    if (!isFinite(seg) || seg < 0) return "";
    const s = Math.ceil(seg);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    const mStr = (mins < 10 ? "0" : "") + mins;
    const sStr = (secs < 10 ? "0" : "") + secs;
    return `${mStr}:${sStr}`;
}

function sanitizarNomeWindows(nome) {
    if (!nome) return "media";
    return String(nome)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 75) || "media";
}

function gravarStatus(statusFile, dados) {
    try {
        const jsonAscii = JSON.stringify(dados).replace(/[\u007F-\uFFFF]/g, (ch) => {
            return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
        });
        Deno.writeTextFileSync(statusFile, jsonAscii);
    } catch (_) {}
}

async function inspecionarMidia(ffprobePath, ffmpegPath, filePath, envVars) {
    try {
        if (ffprobePath) {
            const cmd = new Deno.Command(ffprobePath, {
                args: [
                    "-v", "error",
                    "-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt,width,height",
                    "-of", "json",
                    filePath
                ],
                env: envVars,
                stdout: "piped",
                stderr: "null"
            });
            const out = await cmd.output();
            if (out.success) {
                const txt = new TextDecoder().decode(out.stdout);
                return JSON.parse(txt);
            }
        }
    } catch (_) {}

    // Fallback via ffmpeg -i (para macOS ou quando ffprobe não está disponível)
    try {
        const cmd = new Deno.Command(ffmpegPath, {
            args: ["-hide_banner", "-i", filePath],
            env: envVars,
            stdout: "null",
            stderr: "piped"
        });
        const out = await cmd.output();
        const stderrTxt = new TextDecoder().decode(out.stderr);
        let duration = 0;
        const mDur = stderrTxt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
        if (mDur) {
            duration = parseInt(mDur[1], 10) * 3600 + parseInt(mDur[2], 10) * 60 + parseFloat(mDur[3]);
        }
        let vCodec = "";
        let pixFmt = "";
        const mVid = stderrTxt.match(/Stream\s+#\d+:\d+.*Video:\s*([a-zA-Z0-9_]+)([^\r\n]*)/i);
        if (mVid) {
            vCodec = mVid[1].toLowerCase();
            if (/yuv420p/i.test(mVid[2])) pixFmt = "yuv420p";
        }
        return {
            format: { duration: String(duration) },
            streams: vCodec ? [{ codec_type: "video", codec_name: vCodec, pix_fmt: pixFmt }] : []
        };
    } catch (_) {
        return null;
    }
}

async function converterVideoComProgresso(ffmpegPath, inputPath, outputPath, duracaoTotalSeg, modoEncoder, statusFile, tituloAtual, envVars) {
    let argsVideo;
    if (modoEncoder === "nvenc") {
        argsVideo = ["-c:v", "h264_nvenc", "-preset", "p2", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-pix_fmt", "yuv420p"];
    } else if (modoEncoder === "amf") {
        argsVideo = ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "19", "-qp_p", "19", "-pix_fmt", "yuv420p"];
    } else if (modoEncoder === "qsv") {
        argsVideo = ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "19", "-pix_fmt", "yuv420p"];
    } else if (modoEncoder === "videotoolbox") {
        argsVideo = ["-c:v", "h264_videotoolbox", "-b:v", "18M", "-pix_fmt", "yuv420p"];
    } else {
        argsVideo = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "19", "-pix_fmt", "yuv420p", "-threads", "4"];
    }

    const args = [
        "-y",
        "-i", inputPath,
        ...argsVideo,
        "-c:a", "aac",
        "-b:a", "256k",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        outputPath
    ];

    const child = new Deno.Command(ffmpegPath, {
        args,
        env: envVars,
        stdout: "piped",
        stderr: "null"
    }).spawn();

    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentOutTimeSec = 0;
    let currentSpeed = 1.0;

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const linhas = buffer.split(/\r?\n/);
            buffer = linhas.pop() || "";

            for (const linha of linhas) {
                const [k, v] = linha.split("=");
                if (!k || !v) continue;
                const key = k.trim();
                const val = v.trim();

                if (key === "out_time_us" || key === "out_time_ms") {
                    const us = parseFloat(val);
                    if (!isNaN(us) && us > 0) {
                        currentOutTimeSec = us / 1_000_000;
                    }
                } else if (key === "speed") {
                    const sp = parseFloat(val.replace("x", ""));
                    if (!isNaN(sp) && sp > 0.05) {
                        currentSpeed = sp;
                    }
                } else if (key === "progress" && val === "continue") {
                    if (duracaoTotalSeg > 0) {
                        const frac = Math.min(0.99, Math.max(0, currentOutTimeSec / duracaoTotalSeg));
                        const pctGlobal = Math.round(68 + frac * 30);
                        const restanteSeg = Math.max(0, (duracaoTotalSeg - currentOutTimeSec) / currentSpeed);
                        const etaFmt = formatarSegundosEta(restanteSeg);

                        gravarStatus(statusFile, {
                            phase: "converting",
                            percent: pctGlobal,
                            eta: etaFmt,
                            speed: `${currentSpeed.toFixed(1)}x`,
                            title: tituloAtual,
                            done: false
                        });
                    }
                }
            }
        }
    } catch (_) {}

    const status = await child.status;
    return status.success;
}

async function remuxarRapido(ffmpegPath, inputPath, outputPath, envVars) {
    const cmd = new Deno.Command(ffmpegPath, {
        args: [
            "-y",
            "-i", inputPath,
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "256k",
            "-movflags", "+faststart",
            outputPath
        ],
        env: envVars,
        stdout: "null",
        stderr: "null"
    });
    const out = await cmd.output();
    return out.success;
}

async function garantirAudioMp3(ffmpegPath, inputPath, outputMp3Path, envVars) {
    const cmd = new Deno.Command(ffmpegPath, {
        args: [
            "-y",
            "-i", inputPath,
            "-vn",
            "-c:a", "libmp3lame",
            "-b:a", "320k",
            outputMp3Path
        ],
        env: envVars,
        stdout: "null",
        stderr: "null"
    });
    const out = await cmd.output();
    return out.success;
}

function buscarArquivoComPrefixo(pasta, prefixo) {
    const extsMidiaValidas = [".mp3", ".mp4", ".m4a", ".wav", ".mov", ".webm", ".mkv", ".opus", ".aac", ".ogg"];
    const extsIgnorarOuLimpar = [".webp", ".jpg", ".jpeg", ".png", ".json", ".description", ".part", ".ytdl"];
    let candidatoPreferido = null;
    let candidatoSecundario = null;

    try {
        for (const entry of Deno.readDirSync(pasta)) {
            if (!entry.isFile || !entry.name.startsWith(prefixo)) continue;
            const lower = entry.name.toLowerCase();

            if (extsIgnorarOuLimpar.some((ext) => lower.endsWith(ext))) {
                if (!lower.endsWith(".part") && !lower.endsWith(".ytdl")) {
                    try { Deno.removeSync(`${pasta}${SEP}${entry.name}`); } catch (_) {}
                }
                continue;
            }

            if (lower.endsWith(".mp3") || lower.endsWith(".mp4")) {
                candidatoPreferido = `${pasta}${SEP}${entry.name}`;
            } else if (extsMidiaValidas.some((ext) => lower.endsWith(ext))) {
                candidatoSecundario = `${pasta}${SEP}${entry.name}`;
            }
        }
    } catch (_) {}
    return candidatoPreferido || candidatoSecundario;
}

async function resolverLinkVimeo(rawUrl) {
    let playerUrl = rawUrl;
    let tituloVimeo = "";
    let thumbVimeo = "";

    // 1. Consulta oEmbed oficial do Vimeo para extrair URL de embed (player.vimeo.com), título e thumbnail
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4500);
        const oembedResp = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(rawUrl)}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            },
            signal: ctrl.signal
        });
        clearTimeout(timer);

        if (oembedResp.ok) {
            const data = await oembedResp.json();
            if (data.title) tituloVimeo = String(data.title);
            if (data.thumbnail_url) thumbVimeo = String(data.thumbnail_url);
            if (data.html) {
                const mSrc = String(data.html).match(/src="([^"]+player\.vimeo\.com\/video\/[^"]+)"/i);
                if (mSrc && mSrc[1]) {
                    playerUrl = mSrc[1].replace(/&amp;/g, "&");
                }
            }
            if (playerUrl === rawUrl && data.video_id) {
                playerUrl = `https://player.vimeo.com/video/${data.video_id}`;
            }
        }
    } catch (_) {}

    // 2. Fallback por Regex caso ainda esteja no domínio vimeo.com padrão (suporta links normais, canais e hashes não-listados)
    if (!/player\.vimeo\.com\/video\//i.test(playerUrl)) {
        try {
            const uObj = new URL(rawUrl);
            const hParam = uObj.searchParams.get("h");
            const pathParts = uObj.pathname.split("/").filter(Boolean);

            // Procura ID numérico do vídeo no path (ex.: /1212293046 ou /1212293046/abcdef ou /channels/staffpicks/1212293046)
            let videoId = "";
            let hashPath = "";
            for (let i = 0; i < pathParts.length; i++) {
                if (/^\d{6,}$/.test(pathParts[i])) {
                    videoId = pathParts[i];
                    if (pathParts[i + 1] && /^[a-zA-Z0-9]+$/.test(pathParts[i + 1])) {
                        hashPath = pathParts[i + 1];
                    }
                    break;
                }
            }

            if (videoId) {
                const finalHash = hParam || hashPath;
                playerUrl = `https://player.vimeo.com/video/${videoId}${finalHash ? `?h=${finalHash}` : ""}`;
            }
        } catch (_) {}
    }

    return { playerUrl, tituloVimeo, thumbVimeo };
}

async function main() {
    const reqFile = Deno.args[0];
    const statusFile = Deno.args[1];

    if (!reqFile || !statusFile) {
        Deno.exit(1);
    }

    let req;
    try {
        req = JSON.parse(Deno.readTextFileSync(reqFile));
    } catch (_) {
        gravarStatus(statusFile, { done: true, success: false, error: "Erro ao ler requisição." });
        Deno.exit(1);
    }

    const {
        ytdlpPath,
        ffmpegPath,
        ffprobePath,
        binDir,
        projectDir,
        url,
        isAudio,
        quality,
        customTitle,
        suffix
    } = req;

    // Garante que deno e ffmpeg estejam no PATH para o yt-dlp resolver desafios JS do YouTube
    const currentPath = Deno.env.get("PATH") || Deno.env.get("Path") || "";
    const extraMacPath = IS_WIN ? "" : `${PATH_SEP}/usr/local/bin${PATH_SEP}/opt/homebrew/bin${PATH_SEP}/usr/bin${PATH_SEP}/bin${PATH_SEP}/sbin`;
    const fullPath = `${binDir}${PATH_SEP}${currentPath}${extraMacPath}`;
    const envVars = {
        ...Deno.env.toObject(),
        PATH: fullPath,
        Path: fullPath,
        PYTHONIOENCODING: "utf-8",
        LC_ALL: "en_US.UTF-8",
        LANG: "en_US.UTF-8"
    };

    let tituloAtual = customTitle || "Obtendo informações...";
    let thumbAtual = "";

    gravarStatus(statusFile, {
        phase: "starting",
        percent: 2,
        eta: "Calculando...",
        speed: "",
        title: tituloAtual,
        done: false
    });

    const isVimeo = /vimeo\.com/i.test(url);
    const isSocialMedia = /instagram\.com|tiktok\.com|facebook\.com|twitter\.com|x\.com|vimeo\.com/i.test(url);
    const precisaRecodePotencial = !isAudio && (isSocialMedia || quality === "2160" || quality === "1440" || quality === "best");

    let targetDownloadUrl = url;
    const formatArgs = [];
    if (isVimeo) {
        const infoVimeo = await resolverLinkVimeo(url);
        targetDownloadUrl = infoVimeo.playerUrl;
        if (infoVimeo.tituloVimeo && !customTitle) {
            tituloAtual = infoVimeo.tituloVimeo;
        }
        if (infoVimeo.thumbVimeo) {
            thumbAtual = infoVimeo.thumbVimeo;
        }
        gravarStatus(statusFile, {
            phase: "downloading",
            percent: 4,
            eta: "Conectando...",
            speed: "",
            title: tituloAtual,
            thumbnail: thumbAtual,
            done: false
        });
        formatArgs.push("--referer", "https://vimeo.com/");
    }

    if (isAudio) {
        formatArgs.push("-f", "ba/b/best", "-x", "--audio-format", "mp3", "--audio-quality", "0", "--no-embed-thumbnail");
    } else if (isSocialMedia) {
        if (quality !== "best") {
            formatArgs.push("-f", `bv*[height<=${quality}]+ba/b[height<=${quality}]/best[height<=${quality}]/bv*+ba/b/best`, "-S", "res,br,fps");
        } else {
            formatArgs.push("-f", "bv*+ba/b/best", "-S", "res,br,fps");
        }
        formatArgs.push("--merge-output-format", "mp4");
    } else {
        if (quality === "best") {
            formatArgs.push("-f", "bv*+ba/b/best", "-S", "res,br,fps");
        } else if (quality === "2160" || quality === "1440") {
            formatArgs.push("-f", `bv*[height<=${quality}]+ba/b[height<=${quality}]/best[height<=${quality}]/best`, "-S", "res,br,fps");
        } else {
            formatArgs.push(
                "-f",
                `bv*[vcodec^=avc1][height<=${quality}]+ba[acodec^=mp4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]/best[height<=${quality}]/best`
            );
        }
        formatArgs.push("--merge-output-format", "mp4");
    }

    if (isSocialMedia) {
        formatArgs.push("--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
    }

    const tempPrefix = `_temp_${Date.now()}${suffix}`;
    const outputTemplate = `${projectDir}${SEP}${tempPrefix}.%(ext)s`;

    const ytdlpArgs = [
        "--force-ipv4",
        "--encoding", "utf-8",
        "--ffmpeg-location", binDir,
        "--concurrent-fragments", "6",
        "--newline",
        "--progress",
        "--progress-template", "download:PROG|%(progress._percent_str)s|%(progress._eta_str)s|%(progress._speed_str)s|%(info.thumbnail)j|%(info.title)j",
        ...(IS_WIN ? ["--windows-filenames"] : []),
        "--no-playlist",
        "--no-check-certificates",
        ...formatArgs
    ];

    if (/youtube\.com|youtu\.be/i.test(targetDownloadUrl)) {
        ytdlpArgs.push("--extractor-args", "youtube:player_client=default,ios,android,web,mweb");
    }

    ytdlpArgs.push("-o", outputTemplate, targetDownloadUrl);

    const child = new Deno.Command(ytdlpPath, {
        args: ytdlpArgs,
        cwd: projectDir,
        env: envVars,
        stdout: "piped",
        stderr: "piped"
    }).spawn();

    let ytdlpStderrText = "";
    const stderrPromise = (async () => {
        try {
            const errReader = child.stderr.getReader();
            const errDecoder = new TextDecoder();
            let acc = "";
            while (true) {
                const { value, done } = await errReader.read();
                if (done) break;
                acc += errDecoder.decode(value, { stream: true });
                if (acc.length > 6000) acc = acc.slice(-6000);
            }
            ytdlpStderrText = acc;
        } catch (_) {}
    })();

    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamCount = 0;

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const linhas = buffer.split(/\r?\n/);
            buffer = linhas.pop() || "";

            for (const linha of linhas) {
                if (linha.includes("[download] Destination:")) {
                    streamCount++;
                }

                const idxProg = linha.indexOf("PROG|");
                if (idxProg !== -1) {
                    const partes = linha.substring(idxProg + 5).split("|");
                    const rawPct = (partes[0] || "").replace("%", "").trim();
                    const rawEta = (partes[1] || "").trim();
                    const rawSpeed = (partes[2] || "").trim();
                    const rawThumbJson = (partes[3] || "").trim();
                    const rawTitleJson = partes.slice(4).join("|").trim();

                    if (!thumbAtual && rawThumbJson && rawThumbJson !== "NA" && rawThumbJson !== "\"NA\"") {
                        try {
                            const parsedThumb = JSON.parse(rawThumbJson);
                            if (parsedThumb && typeof parsedThumb === "string" && parsedThumb.startsWith("http")) {
                                thumbAtual = parsedThumb;
                            }
                        } catch (_) {}
                    }

                    if (rawTitleJson && rawTitleJson !== "NA" && rawTitleJson !== "\"NA\"" && !customTitle) {
                        try {
                            const parsedTitle = JSON.parse(rawTitleJson);
                            if (parsedTitle && typeof parsedTitle === "string") {
                                tituloAtual = parsedTitle;
                            }
                        } catch (_) {
                            tituloAtual = rawTitleJson.replace(/^"|"$/g, "");
                        }
                    }

                    const pctNum = parseFloat(rawPct);
                    if (!isNaN(pctNum)) {
                        let pctMapeado = pctNum;

                        if (precisaRecodePotencial) {
                            if (streamCount <= 1) {
                                pctMapeado = 2 + (pctNum * 0.56);
                            } else {
                                pctMapeado = 58 + (pctNum * 0.10);
                            }
                        } else if (!isAudio) {
                            if (streamCount <= 1) {
                                pctMapeado = 2 + (pctNum * 0.83);
                            } else {
                                pctMapeado = 85 + (pctNum * 0.12);
                            }
                        } else {
                            pctMapeado = 2 + (pctNum * 0.90);
                        }

                        const etaLimpo = (rawEta && rawEta !== "NA" && rawEta !== "Unknown") ? rawEta : "";
                        const speedLimpo = (rawSpeed && rawSpeed !== "NA" && rawSpeed !== "Unknown") ? rawSpeed : "";

                        gravarStatus(statusFile, {
                            phase: "downloading",
                            percent: Math.min(97, Math.max(3, Math.round(pctMapeado))),
                            eta: etaLimpo,
                            speed: speedLimpo,
                            title: tituloAtual,
                            thumbnail: thumbAtual,
                            done: false
                        });
                    }
                } else if (linha.includes("[ExtractAudio]") || linha.includes("[Merger]")) {
                    gravarStatus(statusFile, {
                        phase: "processing",
                        percent: precisaRecodePotencial ? 68 : 94,
                        eta: "00:02",
                        speed: "",
                        title: tituloAtual,
                        thumbnail: thumbAtual,
                        done: false
                    });
                }
            }
        }
    } catch (_) {}

    const ytdlpStatus = await child.status;
    await stderrPromise;

    let finalOutputFile = null;
    const tempFileEncontrado = buscarArquivoComPrefixo(projectDir, tempPrefix);

    if (!tempFileEncontrado && !ytdlpStatus.success) {
        let errMsg = "Falha ao baixar mídia.";
        if (ytdlpStderrText) {
            const errLines = ytdlpStderrText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            const errLine = errLines.slice().reverse().find((l) => l.includes("ERROR:") || l.includes("Error:"));
            if (errLine) {
                errMsg = errLine.replace(/^ERROR:\s*/i, "").trim();
            } else if (errLines.length > 0) {
                errMsg = errLines[errLines.length - 1];
            }
        }

        gravarStatus(statusFile, {
            phase: "error",
            percent: 100,
            eta: "",
            title: tituloAtual,
            done: true,
            success: false,
            error: errMsg
        });
        Deno.exit(0);
    }

    if (tempFileEncontrado) {
        const nomeLimpoFinal = sanitizarNomeWindows(
            customTitle || (tituloAtual !== "Obtendo informações..." ? tituloAtual : (isAudio ? "Audio" : "Video"))
        );

        if (precisaRecodePotencial) {
            const finalMp4Path = `${projectDir}${SEP}${nomeLimpoFinal}${suffix}.mp4`;

            const info = await inspecionarMidia(ffprobePath, ffmpegPath, tempFileEncontrado, envVars);
            const duracaoSeg = parseFloat(info?.format?.duration || "0") || 0;
            const vStream = (info?.streams || []).find((s) => s.codec_type === "video");
            const vCodec = (vStream?.codec_name || "").toLowerCase();
            const pixFmt = (vStream?.pix_fmt || "").toLowerCase();

            if (vCodec === "h264" && (pixFmt === "yuv420p" || pixFmt === "")) {
                gravarStatus(statusFile, {
                    phase: "converting",
                    percent: 92,
                    eta: "00:01",
                    speed: "Instantâneo",
                    title: tituloAtual,
                    done: false
                });
                const okRemux = await remuxarRapido(ffmpegPath, tempFileEncontrado, finalMp4Path, envVars);
                if (okRemux) {
                    try { Deno.removeSync(tempFileEncontrado); } catch (_) {}
                } else {
                    try { Deno.renameSync(tempFileEncontrado, finalMp4Path); } catch (_) {}
                }
                finalOutputFile = finalMp4Path;
            } else {
                gravarStatus(statusFile, {
                    phase: "converting",
                    percent: 70,
                    eta: "Calculando...",
                    speed: "Hardware",
                    title: tituloAtual,
                    done: false
                });

                const modosTentativa = IS_WIN ? ["nvenc", "qsv", "amf", "cpu"] : ["videotoolbox", "cpu"];
                let okConv = false;

                for (const modo of modosTentativa) {
                    okConv = await converterVideoComProgresso(
                        ffmpegPath,
                        tempFileEncontrado,
                        finalMp4Path,
                        duracaoSeg,
                        modo,
                        statusFile,
                        tituloAtual,
                        envVars
                    );
                    if (okConv) break;
                }

                if (okConv) {
                    try { Deno.removeSync(tempFileEncontrado); } catch (_) {}
                    finalOutputFile = finalMp4Path;
                } else {
                    try {
                        Deno.renameSync(tempFileEncontrado, finalMp4Path);
                        finalOutputFile = finalMp4Path;
                    } catch (_) {
                        finalOutputFile = tempFileEncontrado;
                    }
                }
            }
        } else if (isAudio) {
            const finalMp3Path = `${projectDir}${SEP}${nomeLimpoFinal}${suffix}.mp3`;
            if (tempFileEncontrado.toLowerCase().endsWith(".mp3")) {
                try {
                    Deno.renameSync(tempFileEncontrado, finalMp3Path);
                    finalOutputFile = finalMp3Path;
                } catch (_) {
                    finalOutputFile = tempFileEncontrado;
                }
            } else {
                const okMp3 = await garantirAudioMp3(ffmpegPath, tempFileEncontrado, finalMp3Path, envVars);
                if (okMp3) {
                    try { Deno.removeSync(tempFileEncontrado); } catch (_) {}
                    finalOutputFile = finalMp3Path;
                } else {
                    try {
                        Deno.renameSync(tempFileEncontrado, finalMp3Path);
                        finalOutputFile = finalMp3Path;
                    } catch (_) {
                        finalOutputFile = tempFileEncontrado;
                    }
                }
            }
        } else {
            const finalMp4Path = `${projectDir}${SEP}${nomeLimpoFinal}${suffix}.mp4`;
            if (tempFileEncontrado.toLowerCase().endsWith(".mp4")) {
                try {
                    Deno.renameSync(tempFileEncontrado, finalMp4Path);
                    finalOutputFile = finalMp4Path;
                } catch (_) {
                    finalOutputFile = tempFileEncontrado;
                }
            } else {
                const okRemux = await remuxarRapido(ffmpegPath, tempFileEncontrado, finalMp4Path, envVars);
                if (okRemux) {
                    try { Deno.removeSync(tempFileEncontrado); } catch (_) {}
                    finalOutputFile = finalMp4Path;
                } else {
                    try {
                        Deno.renameSync(tempFileEncontrado, finalMp4Path);
                        finalOutputFile = finalMp4Path;
                    } catch (_) {
                        finalOutputFile = tempFileEncontrado;
                    }
                }
            }
        }
    }

    gravarStatus(statusFile, {
        phase: "completed",
        percent: 100,
        eta: "00:00",
        speed: "",
        title: tituloAtual,
        finalFilePath: finalOutputFile || "",
        done: true,
        success: true
    });
}

main();
