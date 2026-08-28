# Voice input

Voice input transcribes speech with [Deepgram Flux](https://developers.deepgram.com/) (`flux-general-multi`) and inserts the result at the composer cursor. It never sends the message automatically.

It is available in the desktop app on macOS, Windows, and Linux, and in the Android app. It is not available in the browser.

Select the microphone button beside Send to begin recording. Select the stop button to transcribe, or press Escape to discard the recording. Transcription ends when Deepgram reports the end of the turn, so a pause mid-sentence does not cut the recording short.

Audio is streamed to Deepgram while you speak and is kept in memory only for the current recording.

## Providing a Deepgram API key

Voice input stays disabled until a key is available, rather than failing at the moment the microphone is pressed.

**Desktop** reads the key from the environment, `T3CODE_DEEPGRAM_API_KEY` first and `DEEPGRAM_API_KEY` second. Set it in the repo `.env` so a build carries one, or export it per machine to override a built-in key without rebuilding.

**Android** stores the key on the device. Open Settings, then Voice Input, and paste a key; it is held in the device keystore and is never sent to a T3 Code server. A key baked in at build time through `EXPO_PUBLIC_DEEPGRAM_API_KEY` is used when nothing is saved on the device.

The phone streams audio to Deepgram directly rather than through the server it is connected to, so voice input works against any environment.

## Microphone access

On macOS, grant microphone access to T3 Code when prompted. If access was previously denied, enable it under System Settings, Privacy & Security, Microphone.

On Android, the app asks on the first recording. If access was denied, enable it under the app's permissions in system settings.
