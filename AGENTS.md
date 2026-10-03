# Desktop testing

- Run automated tests in the background. Never bring Liauth or another test
  application to the foreground, steal keyboard focus, or send global input to
  the user's desktop.
- For macOS E2E runs, use a hidden, non-focusable window and prohibit application
  activation before starting the event loop. Verify that the test window stays
  hidden and unfocused. Keep these settings confined to the E2E build.
- If a scenario requires visible native UI or real desktop input, run it on a
  dedicated runner/session. Do not fall back to the user's interactive desktop.
- Preserve test artifacts and report which native interactions remain unverified.
