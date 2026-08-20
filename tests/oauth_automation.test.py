import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "naver_works_oauth.py"
SPEC = importlib.util.spec_from_file_location("naver_works_oauth", SCRIPT)
assert SPEC and SPEC.loader
oauth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oauth)


class OAuthAutomationTests(unittest.TestCase):
    def test_scope_normalization_deduplicates_preserving_order(self):
        self.assertEqual(oauth.normalize_scopes("calendar.read, contact.read calendar.read"), ["calendar.read", "contact.read"])

    def test_default_first_connection_scopes_match_current_console_selection(self):
        scopes = oauth.normalize_scopes(oauth.DEFAULT_SCOPES)
        expected = {
            "openid", "profile", "email", "board", "board.read",
            "calendar", "calendar.read", "contact", "contact.read", "directory.read",
            "form", "form.read", "group.folder.read", "group.note.read", "group.read",
            "orgunit.read", "security.external-browser", "security.external-browser.read",
            "task", "task.read", "user.email.read", "user.profile.read", "user.read",
        }
        self.assertEqual(set(scopes), expected)

    def test_redirect_uri_requires_registered_https_callback(self):
        self.assertEqual(oauth.validate_redirect_uri("https://oauth.example.com/callback").path, "/callback")
        with self.assertRaises(oauth.OAuthSetupError):
            oauth.validate_redirect_uri("http://127.0.0.1:8788/callback")

    def test_authorization_url_uses_official_keys_and_dedicated_domain(self):
        url = oauth.authorization_url(
            "client",
            "https://oauth.example.com/callback",
            ["openid", "profile"],
            "state",
            oauth.DEFAULT_NAVER_WORKS_DOMAIN,
        )
        self.assertIn("client_id=client", url)
        self.assertIn("redirect_uri=https%3A%2F%2Foauth.example.com%2Fcallback", url)
        self.assertIn("response_type=code", url)
        self.assertIn("domain=knocmaint.by-works.net", url)
        self.assertNotIn("clientId=", url)
        self.assertNotIn("redirectUri=", url)
        self.assertNotIn("responseType=", url)

    def test_quick_tunnel_detection_and_callback_path_validation(self):
        self.assertTrue(oauth.is_quick_tunnel_uri("https://calm-bird.trycloudflare.com/callback"))
        self.assertFalse(oauth.is_quick_tunnel_uri("https://oauth.example.com/callback"))
        self.assertEqual(oauth.validate_callback_path("/callback"), "/callback")
        with self.assertRaises(oauth.OAuthSetupError):
            oauth.validate_callback_path("callback")

    def test_portable_cloudflared_is_kept_outside_tracked_project_files(self):
        portable = oauth.local_cloudflared_path()
        self.assertEqual(portable.parent, oauth.ROOT / ".tools" / "cloudflared")
        self.assertTrue(oauth.CLOUDFLARED_RELEASE_URL.startswith("https://github.com/cloudflare/cloudflared/"))

    def test_env_update_removes_duplicate_credential_keys(self):
        source = "NAVER_WORKS_ACCESS_TOKEN=old-one\nOTHER=value\nNAVER_WORKS_ACCESS_TOKEN=old-two\n"
        result = oauth.merge_env_text(source, {"NAVER_WORKS_ACCESS_TOKEN": "new-token", "NAVER_WORKS_MOCK": "false"})
        self.assertEqual(result.count("NAVER_WORKS_ACCESS_TOKEN="), 1)
        self.assertIn("NAVER_WORKS_ACCESS_TOKEN=new-token", result)
        self.assertIn("NAVER_WORKS_MOCK=false", result)

    def test_env_write_creates_file_from_example_or_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / ".env"
            oauth.write_env_file(target, {"NAVER_WORKS_MOCK": "false"})
            self.assertIn("NAVER_WORKS_MOCK=false", target.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
