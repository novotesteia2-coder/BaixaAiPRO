#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BaixaAiRESOLVE — DaVinci Resolve bridge.
Equivalente do host.jsx do BaixaAiPRO (Premiere), usando a API de scripting do Resolve.

Uso: resolve_bridge.py <request.json> <output.json>
request.json: {"action": "...", ...params}
"""

import json
import os
import sys

ACTION = None
REQ = {}
OUT = None


def out_write(obj):
    try:
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=True))
    except Exception:
        pass


def fail(message, code="ERROR"):
    out_write({"status": code, "message": message})
    sys.exit(0)


def _find_fusionscript():
    candidates = []
    if sys.platform == "win32":
        # ResolvePython.exe lives at <Resolve>/ResolvePython/ResolvePython.exe
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        candidates.append(os.path.normpath(os.path.join(exe_dir, "..", "fusionscript.dll")))
        candidates.append(os.path.normpath(os.path.join(exe_dir, "fusionscript.dll")))
    elif sys.platform == "darwin":
        base = sys.base_prefix or sys.prefix
        candidates.append(os.path.normpath(os.path.join(base, "..", "..", "Libraries", "Fusion", "fusionscript.so")))
        candidates.append("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so")
        candidates.append("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Resources/Libraries/Fusion/fusionscript.so")
    else:
        candidates.append("/opt/resolve/libs/Fusion/fusionscript.so")
        candidates.append(os.path.normpath(os.path.join(sys.base_prefix, "..", "libs", "Fusion", "fusionscript.so")))

    for c in candidates:
        if c and os.path.exists(c):
            return c
    return None


def connect_resolve():
    # Ponto para o fusionscript (DLL/dylib) e para o nosso DaVinciResolveScript.py
    lib = _find_fusionscript()
    if lib:
        os.environ["RESOLVE_SCRIPT_LIB"] = lib
    bridge_dir = os.path.dirname(os.path.abspath(__file__))
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)

    try:
        import DaVinciResolveScript as drs
    except Exception as e:
        fail("Nao foi possivel carregar o modulo de scripting do Resolve: %s" % e)
        return None

    try:
        resolve = drs.scriptapp("Resolve")
    except Exception as e:
        fail("Erro ao conectar ao Resolve: %s" % e)
        return None

    if resolve is None:
        fail(
            "O DaVinci Resolve nao esta rodando ou o scripting externo esta desativado. "
            "Abra o Resolve e va em DaVinci Resolve > Preferences > System > General > "
            "External scripting using > Local.",
            "NOT_CONNECTED",
        )
        return None
    return resolve


def fmt_time(seconds):
    s = max(0, int(round(float(seconds or 0))))
    h = s // 3600
    m = (s % 3600) // 60
    sec = s % 60
    if h > 0:
        return "%02d:%02d:%02d" % (h, m, sec)
    return "%02d:%02d" % (m, sec)


def tc_to_frame(tc, fps):
    try:
        p = str(tc).split(":")
        hh, mm, ss = int(p[0]), int(p[1]), int(p[2])
        ff = int(p[3]) if len(p) > 3 else 0
        return int((hh * 3600 + mm * 60 + ss) * float(fps) + ff)
    except Exception:
        return 0


def get_fps(tl):
    try:
        return float(tl.GetSetting("timelineFrameRate") or 24.0)
    except Exception:
        return 24.0


def action_get_project(resolve):
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if project is None:
        out_write({"status": "NO_PROJECT", "message": "Nenhum projeto aberto no DaVinci Resolve."})
        return
    name = ""
    try:
        name = project.GetName() or ""
    except Exception:
        pass
    tl = project.GetCurrentTimeline()
    result = {
        "status": "OK",
        "projectName": name,
        "hasTimeline": False,
        "timelineName": "",
        "playheadSeconds": 0,
        "playheadFormatted": "00:00",
    }
    if tl is not None:
        try:
            fps = get_fps(tl)
            tc = tl.GetCurrentTimecode() or "00:00:00:00"
            frame = tc_to_frame(tc, fps)
            result["hasTimeline"] = True
            result["timelineName"] = tl.GetName() or ""
            result["playheadSeconds"] = round(frame / fps, 2)
            result["playheadFormatted"] = fmt_time(frame / fps)
        except Exception:
            result["hasTimeline"] = True
            result["timelineName"] = (tl.GetName() if tl else "") or ""
    out_write(result)


def action_get_candidates(resolve):
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if project is None:
        out_write({"status": "NO_PROJECT", "message": "Nenhum projeto aberto no DaVinci Resolve."})
        return
    tl = project.GetCurrentTimeline()
    if tl is None:
        out_write({"status": "NO_TIMELINE", "message": "Abra uma timeline no DaVinci Resolve antes de usar o reconhecedor."})
        return

    fps = get_fps(tl)
    try:
        tc = tl.GetCurrentTimecode() or "00:00:00:00"
    except Exception:
        tc = "00:00:00:00"
    playhead_frame = tc_to_frame(tc, fps)
    playhead_seconds = round(playhead_frame / fps, 2)

    candidates = []

    def scan_track(track_type, label_prefix):
        try:
            n = tl.GetTrackCount(track_type)
        except Exception:
            n = 0
        for idx in range(1, n + 1):
            try:
                items = tl.GetItemListInTrack(track_type, idx)
            except Exception:
                continue
            if not items:
                continue
            for it in items:
                try:
                    start = float(it.GetStart())
                    end = float(it.GetEnd())
                except Exception:
                    continue
                if not (start <= playhead_frame < end):
                    continue
                try:
                    mp_item = it.GetMediaPoolItem()
                    if mp_item is None:
                        continue
                    media_path = mp_item.GetClipProperty("File Path") or ""
                except Exception:
                    media_path = ""
                if not media_path:
                    continue
                try:
                    clip_name = it.GetName() or mp_item.GetName() or "Clipe"
                except Exception:
                    clip_name = "Clipe"
                try:
                    src_start = float(it.GetSourceStartFrame())
                    src_end = float(it.GetSourceEndFrame())
                except Exception:
                    src_start = 0.0
                    src_end = 0.0
                clip_dur = max(0.0, end - start)
                src_dur = max(0.0, src_end - src_start)
                speed_ratio = (src_dur / clip_dur) if clip_dur > 0.01 and src_dur > 0.01 else 1.0
                rel = max(0.0, playhead_frame - start)
                src_frame_at_ph = src_start + rel * speed_ratio
                start_offset = round(max(0.0, src_frame_at_ph) / fps, 2)
                clip_duration = round(clip_dur / fps, 2)
                candidates.append({
                    "clipName": clip_name,
                    "trackName": "%s %d" % (label_prefix, idx),
                    "mediaPath": media_path,
                    "startOffset": start_offset,
                    "clipDuration": clip_duration,
                })

    # Audio primeiro (prioridade do reconhecedor), depois video.
    scan_track("audio", "Audio")
    scan_track("video", "Video")

    if not candidates:
        out_write({
            "status": "NO_CLIPS",
            "message": "Nenhum clipe sob a agulha (%s). Posicione a agulha sobre um clipe de video ou musica." % fmt_time(playhead_seconds),
            "playheadSeconds": playhead_seconds,
            "playheadFormatted": fmt_time(playhead_seconds),
        })
        return

    out_write({
        "status": "OK",
        "timelineName": (tl.GetName() if tl else "") or "",
        "playheadSeconds": playhead_seconds,
        "playheadFormatted": fmt_time(playhead_seconds),
        "candidates": candidates,
    })


def action_import_media(resolve):
    file_path = REQ.get("filePath") or ""
    insert_on_timeline = bool(REQ.get("insertOnTimeline", False))

    if not file_path or not os.path.exists(file_path):
        out_write({"status": "IMPORT_FAILED", "message": "Arquivo nao encontrado: %s" % file_path})
        return

    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if project is None:
        out_write({"status": "NO_PROJECT", "message": "Nenhum projeto aberto no DaVinci Resolve."})
        return
    mp = project.GetMediaPool()
    tl = project.GetCurrentTimeline()

    try:
        items = mp.ImportMedia([file_path])
    except Exception as e:
        out_write({"status": "IMPORT_FAILED", "message": "Falha ao importar no Media Pool: %s" % e})
        return

    name = os.path.basename(file_path)
    if not items or len(items) == 0:
        # Ja pode existir no pool: nao considera erro, apenas tenta localizar por caminho.
        out_write({"status": "SUCCESS", "name": name, "inserted": False, "note": "already_in_pool"})
        return

    inserted = False
    if insert_on_timeline and tl is not None:
        try:
            fps = get_fps(tl)
            tc = tl.GetCurrentTimecode() or "00:00:00:00"
            playhead_frame = tc_to_frame(tc, fps)
            # Adiciona uma nova trilha de audio e insere na agulha (equivale ao "nova track" do Premiere)
            tl.AddTrack("audio")
            audio_count = tl.GetTrackCount("audio")
            res = mp.AppendToTimeline([{
                "mediaPoolItem": items[0],
                "mediaType": 2,
                "trackIndex": audio_count,
                "recordFrame": float(playhead_frame),
            }])
            if res:
                inserted = True
        except Exception:
            inserted = False

    out_write({"status": "SUCCESS", "name": name, "inserted": inserted})


def action_open_folder(resolve):
    folder = REQ.get("folder") or ""
    if not folder:
        fail("Pasta vazia.")
    try:
        if sys.platform == "win32":
            os.startfile(folder)
        elif sys.platform == "darwin":
            import subprocess
            subprocess.Popen(["open", folder])
        else:
            import subprocess
            subprocess.Popen(["xdg-open", folder])
        out_write({"status": "OK"})
    except Exception as e:
        out_write({"status": "ERROR", "message": str(e)})


def main():
    global ACTION, REQ, OUT
    if len(sys.argv) < 3:
        print("Uso: resolve_bridge.py <request.json> <output.json>")
        sys.exit(1)
    req_file = sys.argv[1]
    OUT = sys.argv[2]

    try:
        with open(req_file, "r", encoding="utf-8-sig") as f:
            REQ = json.load(f)
    except Exception as e:
        OUT = sys.argv[2]
        out_write({"status": "ERROR", "message": "JSON de requisicao invalido: %s" % e})
        sys.exit(0)

    ACTION = REQ.get("action") or ""

    # open_folder nao precisa do Resolve
    if ACTION == "open_folder":
        action_open_folder(None)
        return

    resolve = connect_resolve()
    if resolve is None:
        return

    handlers = {
        "get_project": action_get_project,
        "get_candidates": action_get_candidates,
        "import_media": action_import_media,
    }
    h = handlers.get(ACTION)
    if h is None:
        out_write({"status": "ERROR", "message": "Acao desconhecida: %s" % ACTION})
        return
    try:
        h(resolve)
    except Exception as e:
        out_write({"status": "ERROR", "message": str(e)})


if __name__ == "__main__":
    main()
