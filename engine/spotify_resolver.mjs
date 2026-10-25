// Resolvedor de Músicas, Álbuns e Playlists do Spotify para YouTube URL + Metadados

async function buscarVideoIdYouTube(artist, title) {
    try {
        const query = `${artist} - ${title} audio`;
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=pt`;
        const resp = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8"
            }
        });
        if (resp.ok) {
            const html = await resp.text();
            const m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
            if (m && m[1]) {
                return {
                    url: `https://www.youtube.com/watch?v=${m[1]}`,
                    videoId: m[1]
                };
            }
        }
    } catch (_) {}

    // Fallback para busca direta via yt-dlp caso necessário
    return {
        url: `ytsearch1:${artist} - ${title}`,
        videoId: null
    };
}

function limparTextoSpotify(str) {
    if (!str) return "";
    return String(str).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function resolverItensEmLotes(itens, tamanhoLote = 6) {
    const resultados = [];
    for (let i = 0; i < itens.length; i += tamanhoLote) {
        const lote = itens.slice(i, i + tamanhoLote);
        const promessas = lote.map(async (item) => {
            const yt = await buscarVideoIdYouTube(item.artist, item.songTitle);
            const thumbFallback = yt.videoId ? `https://i.ytimg.com/vi/${yt.videoId}/mqdefault.jpg` : "";
            return {
                title: item.artist ? `${item.artist} - ${item.songTitle}` : item.songTitle,
                songTitle: item.songTitle,
                artist: item.artist,
                cover: item.cover || thumbFallback,
                youtubeUrl: yt.url,
                youtubeVideoId: yt.videoId
            };
        });
        const resolvidos = await Promise.all(promessas);
        resultados.push(...resolvidos);
    }
    return resultados;
}

function gravarJsonSeguro(caminho, dados) {
    const jsonAscii = JSON.stringify(dados).replace(/[\u007F-\uFFFF]/g, (ch) => {
        return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
    });
    Deno.writeTextFileSync(caminho, jsonAscii);
}

async function main() {
    const spotifyUrl = Deno.args[0];
    const outFile = Deno.args[1];

    if (!spotifyUrl || !outFile) {
        console.error("Uso: deno run -A spotify_resolver.mjs <spotifyUrl> <outFile>");
        Deno.exit(1);
    }

    try {
        const match = spotifyUrl.match(/(track|playlist|album)\/([a-zA-Z0-9]+)/i);
        if (!match) {
            gravarJsonSeguro(outFile, {
                status: "ERROR",
                message: "Link do Spotify inválido. Use um link de música (track), playlist ou álbum."
            });
            Deno.exit(0);
        }

        const kind = match[1].toLowerCase();
        const id = match[2];

        const embedUrl = `https://open.spotify.com/embed/${kind}/${id}`;
        const resp = await fetch(embedUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
            }
        });

        if (!resp.ok) {
            gravarJsonSeguro(outFile, {
                status: "ERROR",
                message: "Não foi possível acessar os dados do Spotify."
            });
            Deno.exit(0);
        }

        const html = await resp.text();
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);

        const rawTracks = [];
        let collectionName = "";
        let defaultCover = "";

        if (nextMatch && nextMatch[1]) {
            const data = JSON.parse(nextMatch[1]);
            const entity = data?.props?.pageProps?.state?.data?.entity;

            if (entity) {
                collectionName = limparTextoSpotify(entity.name || entity.title || "Spotify");
                const images = entity.visualIdentity?.image || entity.coverArt?.sources || [];
                if (images.length > 0) {
                    defaultCover = images[0].url || "";
                }

                if (kind === "track" || entity.type === "track") {
                    const songTitle = limparTextoSpotify(entity.name || entity.title || "Música");
                    const artist = limparTextoSpotify(
                        (entity.artists || []).map((a) => a.name).join(", ") || entity.subtitle || ""
                    );
                    rawTracks.push({
                        songTitle,
                        artist,
                        cover: defaultCover
                    });
                } else if (Array.isArray(entity.trackList) && entity.trackList.length > 0) {
                    for (const t of entity.trackList) {
                        const songTitle = limparTextoSpotify(t.title || t.name || "Música");
                        const artist = limparTextoSpotify(t.subtitle || "");
                        rawTracks.push({
                            songTitle,
                            artist,
                            cover: defaultCover
                        });
                    }
                }
            }
        }

        // Fallback via oEmbed caso __NEXT_DATA__ não tenha retornado
        if (rawTracks.length === 0) {
            const oembedResp = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`);
            if (oembedResp.ok) {
                const oe = await oembedResp.json();
                if (oe && oe.title) {
                    rawTracks.push({
                        songTitle: limparTextoSpotify(oe.title),
                        artist: "",
                        cover: oe.thumbnail_url || ""
                    });
                }
            }
        }

        if (rawTracks.length === 0) {
            gravarJsonSeguro(outFile, {
                status: "ERROR",
                message: "Nenhuma música encontrada neste link do Spotify."
            });
            Deno.exit(0);
        }

        const resolvedTracks = await resolverItensEmLotes(rawTracks, 6);

        gravarJsonSeguro(outFile, {
            status: "OK",
            kind,
            collectionName,
            tracks: resolvedTracks
        });
    } catch (err) {
        gravarJsonSeguro(outFile, {
            status: "ERROR",
            message: String(err?.message || err)
        });
    }
}

main();
