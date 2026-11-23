"""Exercise the built tool at a project subpath in Chromium, with two offline daily snapshots."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    screenshots = ROOT / "browser-checks"
    screenshots.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        site = Path(temporary) / "rangeledger"
        shutil.copytree(ROOT / "dist", site)
        shutil.rmtree(site / "data", ignore_errors=True)
        for day, now in (("day1", "2026-11-22T14:00:00Z"), ("day2", "2026-11-23T14:00:00Z")):
            subprocess.run(["node", str(ROOT / "scripts/capture.mjs"), "--fixtures", str(ROOT / "tests/fixtures" / day),
                            "--cache", str(Path(temporary) / "cache"), "--out", str(site / "data"), "--now", now], check=True, capture_output=True)
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=temporary))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                context = browser.new_context(viewport={"width": 1280, "height": 1000}, accept_downloads=True)
                page = context.new_page()
                page.route("**/*", lambda r: r.continue_() if "127.0.0.1" in r.request.url else r.abort())
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"http://127.0.0.1:{server.server_port}/rangeledger/")
                page.wait_for_selector("#providers tbody tr")
                assert page.locator("#snapshot option").count() == 2
                assert page.locator("#providers tbody tr").count() == 6
                assert "34 prefixes" in page.locator("#snapshot-note").inner_text()

                page.fill("#ip", "16.52.1.1")
                page.click("#lookup button")
                res = page.locator("#lookup-result").inner_text()
                assert "16.52.0.0/16" in res and "Canadian region" in res, res
                page.fill("#ip", "2606:4700::1")
                page.click("#lookup button")
                assert "Cloudflare" in page.locator("#lookup-result").inner_text()
                page.fill("#ip", "not-an-ip")
                page.click("#lookup button")
                assert "isn’t a valid" in page.locator("#lookup-result").inner_text()

                assert page.locator("#changes details").count() == 3
                page.select_option("#change-provider", "github")
                assert page.locator("#changes details").count() == 1

                page.select_option("#x-provider", "aws")
                page.check("#x-canada")
                page.select_option("#x-format", "nginx")
                assert "allow 16.52.0.0/16;" in page.locator("#x-preview").input_value()
                with page.expect_download() as dl:
                    page.click("#x-download")
                assert dl.value.suggested_filename == "aws-2026-11-23.conf"
                page.select_option("#x-provider", "fastly")
                assert page.locator("#x-canada").is_disabled()

                # The older snapshot still loads and shows its own counts.
                page.select_option("#snapshot", "2026-11-22")
                page.wait_for_function("document.querySelector('#snapshot-note').textContent.includes('33 prefixes')")

                page.screenshot(path=str(screenshots / "desktop.png"), full_page=True)
                page.set_viewport_size({"width": 390, "height": 844})
                assert page.evaluate("document.body.scrollWidth <= window.innerWidth + 1")
                page.screenshot(path=str(screenshots / "mobile.png"), full_page=True)
                assert not errors, errors
                browser.close()
            print("Browser checks passed: subpath, snapshots, lookup, changes, allowlist export and mobile layout")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
