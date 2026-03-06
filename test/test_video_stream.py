"""
Playwright test: verify H.264 video stream displays in the browser.

Prerequisites: mim_data_utils server running, USB camera publisher with logging enabled.
Run: python test/test_video_stream.py
"""
import sys
import time
from playwright.sync_api import sync_playwright


def main():
    timeout_s = 30
    print(f"Starting Playwright video stream test (timeout {timeout_s}s) ...")

    with sync_playwright() as p:
        # Use system Chrome for proper H.264 codec support
        # (headless shell lacks proprietary codecs)
        try:
            browser = p.chromium.launch(headless=True, channel="chrome")
            print("Using system Chrome")
        except Exception:
            browser = p.chromium.launch(headless=True)
            print("Falling back to bundled Chromium (H.264 may not work)")

        page = browser.new_page()

        console_msgs = []
        page.on("console", lambda msg: console_msgs.append(f"[{msg.type}] {msg.text}"))

        print("Navigating to http://127.0.0.1:8000/ ...")
        page.goto("http://127.0.0.1:8000/", wait_until="domcontentloaded")

        # Wait for RT fragments to load
        print("Waiting for video data ...")
        start = time.time()

        while time.time() - start < timeout_s:
            result = page.evaluate("""() => {
                if (typeof cameras === 'undefined' || !cameras.size) return null;
                let any_loaded = false;
                cameras.forEach((cam) => {
                    let rt = cam.realtimeVideoStore;
                    if (rt && rt.segments.filter(s => s.loaded).length > 0) any_loaded = true;
                });
                return any_loaded ? true : null;
            }""")
            if result:
                break
            page.wait_for_timeout(500)

        # Let a few more fragments arrive
        page.wait_for_timeout(2000)
        elapsed = time.time() - start

        # Full diagnostic
        diag = page.evaluate("""() => {
            let result = {
                imageVisible: typeof imageVisible !== 'undefined' ? imageVisible : null,
                isFrozen: typeof isFrozen !== 'undefined' ? isFrozen : null,
                absTime: null,
                lastTraceTime: null,
                cameras: [],
            };

            try { result.absTime = scene.absoluteTime(); } catch(e) { result.absTime = 'error: ' + e.message; }
            try { result.lastTraceTime = traces.getLastTime(); } catch(e) {}

            if (typeof cameras !== 'undefined') {
                cameras.forEach((cam, name) => {
                    let rt = cam.realtimeVideoStore;
                    let lt = cam.videoStore;
                    let camInfo = {
                        name: name,
                        rt_initLoaded: rt ? rt.initLoaded : false,
                        rt_segments: rt ? rt.segments.length : 0,
                        rt_loaded: rt ? rt.segments.filter(s => s.loaded).length : 0,
                        rt_queue: rt ? rt._appendQueue.length : 0,
                        rt_msState: (rt && rt.mediaSource) ? rt.mediaSource.readyState : 'none',
                        lt_initLoaded: lt ? lt.initLoaded : false,
                        lt_segments: lt ? lt.segments.length : 0,
                        lt_loaded: lt ? lt.segments.filter(s => s.loaded).length : 0,
                        lt_msState: (lt && lt.mediaSource) ? lt.mediaSource.readyState : 'none',
                        rt_videoW: cam.realtimeVideoEl ? cam.realtimeVideoEl.videoWidth : 0,
                        rt_videoH: cam.realtimeVideoEl ? cam.realtimeVideoEl.videoHeight : 0,
                        rt_readyState: cam.realtimeVideoEl ? cam.realtimeVideoEl.readyState : 0,
                        rt_display: cam.realtimeVideoEl ? cam.realtimeVideoEl.style.display : 'n/a',
                        lt_videoW: cam.videoEl ? cam.videoEl.videoWidth : 0,
                        lt_videoH: cam.videoEl ? cam.videoEl.videoHeight : 0,
                        img_display: cam.imgEl ? cam.imgEl.style.display : 'n/a',
                        video_display: cam.videoEl ? cam.videoEl.style.display : 'n/a',
                        rt_videoError: cam.realtimeVideoEl ? (cam.realtimeVideoEl.error ? cam.realtimeVideoEl.error.message : null) : null,
                    };
                    // Segment time ranges (first 2 + last 2)
                    if (rt && rt.segments.length > 0) {
                        let segs = rt.segments;
                        let first = segs.slice(0, 2).map(s => ({ts: s.time_start, te: s.time_end, loaded: s.loaded}));
                        let last = segs.slice(-2).map(s => ({ts: s.time_start, te: s.time_end, loaded: s.loaded}));
                        camInfo.rt_firstSegs = first;
                        camInfo.rt_lastSegs = last;
                    }
                    try {
                        let t = scene.absoluteTime();
                        camInfo.rt_isReadyForAbsTime = rt ? rt.isVideoReadyForTime(t) : false;
                        camInfo.rt_hasRecentVideo = rt ? rt.hasRecentVideo(t, 2.0) : false;
                        camInfo.lt_isReadyForAbsTime = lt ? lt.isVideoReadyForTime(t) : false;
                    } catch(e) {
                        camInfo.syncError = e.message;
                    }
                    result.cameras.push(camInfo);
                });
            }
            return result;
        }""")

        print(f"\n--- Global state after {elapsed:.1f}s ---")
        print(f"  imageVisible: {diag.get('imageVisible')}")
        print(f"  isFrozen: {diag.get('isFrozen')}")
        print(f"  absTime (scene): {diag.get('absTime')}")
        print(f"  lastTraceTime: {diag.get('lastTraceTime')}")

        cameras = diag.get('cameras', [])
        print(f"\n--- Cameras ({len(cameras)}) ---")
        for cam in cameras:
            print(f"\n  Camera: {cam['name']}")
            print(f"    RT store: init={cam['rt_initLoaded']}, segments={cam['rt_segments']}, "
                  f"loaded={cam['rt_loaded']}, queue={cam['rt_queue']}, MS={cam['rt_msState']}")
            print(f"    RT video: {cam['rt_videoW']}x{cam['rt_videoH']}, "
                  f"readyState={cam['rt_readyState']}, display='{cam['rt_display']}'")
            if cam.get('rt_videoError'):
                print(f"    RT video error: {cam['rt_videoError']}")
            print(f"    RT isReadyForAbsTime: {cam.get('rt_isReadyForAbsTime')}")
            print(f"    RT hasRecentVideo: {cam.get('rt_hasRecentVideo')}")
            if cam.get('rt_firstSegs'):
                print(f"    RT first segments: {cam['rt_firstSegs']}")
            if cam.get('rt_lastSegs'):
                print(f"    RT last segments: {cam['rt_lastSegs']}")
            print(f"    LT store: init={cam['lt_initLoaded']}, segments={cam['lt_segments']}, "
                  f"loaded={cam['lt_loaded']}, MS={cam['lt_msState']}")
            print(f"    Display: video='{cam['video_display']}', rt='{cam['rt_display']}', img='{cam['img_display']}'")
            if 'syncError' in cam:
                print(f"    syncError: {cam['syncError']}")

        # Console messages
        errors = [m for m in console_msgs if m.startswith("[error")]
        warnings = [m for m in console_msgs if m.startswith("[warning")]
        sb_issues = [m for m in console_msgs if "SourceBuffer" in m or "appendBuffer" in m or "VideoStore" in m]
        if errors or sb_issues or warnings:
            print(f"\n--- Console: errors={len(errors)}, warnings={len(warnings)}, SB issues={len(sb_issues)} ---")
            for e in (errors + sb_issues + warnings)[:20]:
                print(f"  {e}")

        # Verdict
        print(f"\n--- Results ---")
        all_pass = True

        def check(name, cond):
            nonlocal all_pass
            status = "PASS" if cond else "FAIL"
            if not cond:
                all_pass = False
            print(f"  [{status}] {name}")

        check("Camera panel created", len(cameras) > 0)
        check("imageVisible is True", diag.get('imageVisible') == True)
        check("RT init loaded", any(c.get("rt_initLoaded") for c in cameras))
        check("RT fragments appended", any(c.get("rt_loaded", 0) > 0 for c in cameras))
        check("RT MediaSource open", any(c.get("rt_msState") == "open" for c in cameras))
        check("RT hasRecentVideo(absTime, 2s)", any(c.get("rt_hasRecentVideo") for c in cameras))
        check("RT video decoded (videoWidth > 0)", any((c.get("rt_videoW") or 0) > 0 for c in cameras))
        check("RT video element visible", any(c.get("rt_display") == '' for c in cameras))
        check("No SourceBuffer errors", not any("SourceBuffer" in m for m in console_msgs))

        browser.close()

        print(f"\n{'ALL TESTS PASSED' if all_pass else 'SOME TESTS FAILED'}")
        return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
