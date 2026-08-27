package expo.modules.t3speech

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.concurrent.thread
import kotlin.math.min
import kotlin.math.sqrt

private const val SAMPLE_RATE = 16_000
private const val FRAME_SAMPLES = 1_024

/**
 * Streams microphone PCM to JavaScript so it can be forwarded to a
 * transcription socket while the user is still speaking.
 *
 * Audio is emitted as base64 16-bit little-endian mono at 16 kHz -- the format
 * Deepgram is told to expect. Nothing is buffered here: a long dictation costs
 * no memory and the server sees audio as it arrives.
 */
class T3SpeechModule : Module() {
  private var recorder: AudioRecord? = null
  @Volatile private var running = false
  private var worker: Thread? = null

  override fun definition() = ModuleDefinition {
    Name("T3Speech")

    Events("onAudio", "onLevel", "onError")

    Function("isAvailable") {
      val context = appContext.reactContext ?: return@Function false
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    }

    Function("start") {
      if (running) return@Function
      val context = appContext.reactContext ?: throw IllegalStateException("no android context")
      if (
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
          PackageManager.PERMISSION_GRANTED
      ) {
        throw IllegalStateException("microphone permission was not granted")
      }

      val minBuffer =
        AudioRecord.getMinBufferSize(
          SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
        )
      if (minBuffer <= 0) throw IllegalStateException("this device cannot record 16 kHz mono PCM")

      // VOICE_RECOGNITION asks the platform for the un-beautified capture path:
      // no automatic gain ramping or aggressive noise suppression, which a
      // speech model reads better than the "communication" preset.
      val record =
        AudioRecord(
          MediaRecorder.AudioSource.VOICE_RECOGNITION,
          SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          maxOf(minBuffer, FRAME_SAMPLES * 2 * 4),
        )
      if (record.state != AudioRecord.STATE_INITIALIZED) {
        record.release()
        throw IllegalStateException("the microphone could not be opened")
      }

      recorder = record
      running = true
      record.startRecording()
      worker = thread(name = "t3-speech-capture") { pump(record) }
    }

    AsyncFunction("stop") { stopCapture() }

    OnDestroy { stopCapture() }
  }

  private fun pump(record: AudioRecord) {
    val samples = ShortArray(FRAME_SAMPLES)
    val bytes = ByteArray(FRAME_SAMPLES * 2)
    val startedAt = System.currentTimeMillis()
    var lastLevelAt = 0L
    try {
      while (running) {
        val read = record.read(samples, 0, samples.size)
        if (read <= 0) continue

        for (index in 0 until read) {
          val sample = samples[index].toInt()
          bytes[index * 2] = (sample and 0xFF).toByte()
          bytes[index * 2 + 1] = ((sample shr 8) and 0xFF).toByte()
        }
        sendEvent(
          "onAudio",
          mapOf("pcm" to Base64.encodeToString(bytes, 0, read * 2, Base64.NO_WRAP)),
        )

        val now = System.currentTimeMillis()
        if (now - lastLevelAt >= 100) {
          lastLevelAt = now
          var energy = 0.0
          for (index in 0 until read) {
            val normalized = samples[index] / 32_768.0
            energy += normalized * normalized
          }
          sendEvent(
            "onLevel",
            mapOf(
              "level" to min(1.0, sqrt(energy / read) * 8),
              "elapsedMs" to (now - startedAt).toInt(),
            ),
          )
        }
      }
    } catch (error: Throwable) {
      if (running) sendEvent("onError", mapOf("message" to (error.message ?: "microphone failed")))
    }
  }

  private fun stopCapture() {
    if (!running && recorder == null) return
    running = false
    worker?.join(500)
    worker = null
    recorder?.let { record ->
      runCatching { if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) record.stop() }
      record.release()
    }
    recorder = null
  }
}
