import { EventEmitter } from "events";
import { AUDIO_CLIP_SECONDS } from "../config.js";

const AUDIO_CHANNEL_COUNT = 2;
const AUDIO_SAMPLE_RATE_HERTZ = 48000;
const AUDIO_ANALYZE_INTERVAL_MS = 250;
const AUDIO_SINGLE_SAMPLE_BYTES = 2 * AUDIO_CHANNEL_COUNT; // LINEAR16 -> 16 bits -> 2 bytes per channel sample
const AUDIO_BYTES_PER_SECOND = AUDIO_SINGLE_SAMPLE_BYTES * AUDIO_SAMPLE_RATE_HERTZ;
const AUDIO_BUFFER_SIZE = AUDIO_BYTES_PER_SECOND * AUDIO_CLIP_SECONDS;
const AUDIO_SILENCE_CHUNK = Buffer.alloc(AUDIO_BYTES_PER_SECOND * AUDIO_ANALYZE_INTERVAL_MS / 1000, 0);

const RECOGNIZE_STREAM_TIMEOUT_SILENCE_MS = 5000;
const RECOGNIZE_STREAM_MAX_CHUNK_SIZE = 5000000;
const RECOGNIZE_STREAM_LIFETIME_MS = 210000;
const RECOGNIZE_STREAM_OPTIONS = {
    config: {
        encoding: "LINEAR16",
        languageCode: "en-US",
        sampleRateHertz: AUDIO_SAMPLE_RATE_HERTZ,
        audioChannelCount: AUDIO_CHANNEL_COUNT
    },
    interimResults: true
};

export default class VoiceAnalyzer extends EventEmitter {

    _phraseSets;

    _speechClient = null;

    _audioBuffer = Buffer.alloc(AUDIO_BUFFER_SIZE, 0);
    _audioBufferLength = 0;

    _audioChunkQueue = [];

    _audioReadStream = null;
    _recognizeStream = null;

    _isSilent = false;
    _silentTimestamp;

    _analyzeTimestamp;

    _timeoutEnd;
    _timeoutStart;
    _timeoutWriteAudioToRecognizer;

    _start = this._start.bind(this);
    _end = this._end.bind(this);

    _writeAudioToRecognizer = this._writeAudioToRecognizer.bind(this);
    _scheduleWriteAudioToRecognizer = this._scheduleWriteAudioToRecognizer.bind(this);

    _onSpeechRecognized = this._onSpeechRecognized.bind(this);
    _onAudioReceived = this._onAudioReceived.bind(this);

    constructor(phraseSets, speechClient, audioReadStream) {
        super();
        this._phraseSets = phraseSets;
        this._speechClient = speechClient;
        this._audioReadStream = audioReadStream;
        this._analyzeTimestamp = Date.now();
        audioReadStream.on("data", this._onAudioReceived);
    }

    destroy() {
        this.removeAllListeners();
        this._end();

        this._audioReadStream.removeListener("data", this._onAudioReceived);
    }

    getAudioBuffer() {
        if (this._timeoutWriteAudioToRecognizer) {
            this._writeAudioToRecognizer();
        }
        if (this._isSilent) {
            this._writeSilenceToAudioBuffer();
        }

        return this._audioBuffer;
    }

    getAudioBufferLength() {
        return this._audioBufferLength;
    }

    _start() {
        this._end(true);
        this._setSilentState(false);

        this._recognizeStream = this._speechClient
            .streamingRecognize(
                Object.assign({}, RECOGNIZE_STREAM_OPTIONS, {
                    speechContexts: [{
                        phrases: [].concat(...this._phraseSets?.map(phraseSet => phraseSet.phrases)),
                        boost: 20
                    }]
                })
            )
            .on("data", this._onSpeechRecognized)
            .on("error", e => {
                console.error(e);
                console.log("Attempting to reconnect...");
                this._start(); // attempt to restart speech client
            });

        this._timeoutStart = setTimeout(this._start, RECOGNIZE_STREAM_LIFETIME_MS);
        this._scheduleWriteAudioToRecognizer();
        this._scheduleEndAudioRecognizer();
    }

    _end(keepSilentState) {
        if (!keepSilentState) {
            this._setSilentState(true);
        }

        if (this._recognizeStream) {
            this._recognizeStream.removeAllListeners();
            this._recognizeStream.destroy();
            this._recognizeStream = null;
        }

        if (this._timeoutStart) {
            clearTimeout(this._timeoutStart);
            this._timeoutStart = undefined;
        }

        this._clearEndAudioRecognizerSchedule();
        this._clearWriteAudioToRecognizerSchedule();
    }

    _setSilentState(isSilent) {
        if (this._isSilent === isSilent) {
            return;
        }

        this._isSilent = isSilent;

        if (isSilent) {
            this._silentTimestamp = Date.now();
        } else if (this._silentTimestamp) {
            this._writeSilenceToAudioBuffer();
        }
    }

    _scheduleEndAudioRecognizer() {
        if (this._timeoutEnd) {
            clearTimeout(this._timeoutEnd);
        }
        this._timeoutEnd = setTimeout(this._end, RECOGNIZE_STREAM_TIMEOUT_SILENCE_MS);
    }

    _clearEndAudioRecognizerSchedule() {
        if (this._timeoutEnd) {
            clearTimeout(this._timeoutEnd);
            this._timeoutEnd = undefined;
        }
    }

    _scheduleWriteAudioToRecognizer() {
        if (this._timeoutWriteAudioToRecognizer) {
            clearTimeout(this._timeoutWriteAudioToRecognizer);
        }
        this._timeoutWriteAudioToRecognizer = setTimeout(this._writeAudioToRecognizer, AUDIO_ANALYZE_INTERVAL_MS);
    }

    _clearWriteAudioToRecognizerSchedule() {
        if (this._timeoutWriteAudioToRecognizer) {
            clearTimeout(this._timeoutWriteAudioToRecognizer);
            this._timeoutWriteAudioToRecognizer = undefined;
        }
    }

    _writeAudioToRecognizer() {
        const now = Date.now();
        const secondsElapsed = (now - this._analyzeTimestamp) / 1000;

        this._analyzeTimestamp = now;
        this._clearWriteAudioToRecognizerSchedule();

        if (this._recognizeStream) {
            let chunk = Buffer.concat(this._audioChunkQueue);
            if (chunk.length > RECOGNIZE_STREAM_MAX_CHUNK_SIZE) {
                this._audioChunkQueue = [chunk.slice(RECOGNIZE_STREAM_MAX_CHUNK_SIZE)];
                chunk = chunk.slice(0, RECOGNIZE_STREAM_MAX_CHUNK_SIZE);
            } else if (chunk.length === 0) {
                chunk = AUDIO_SILENCE_CHUNK;
            } else {
                this._audioChunkQueue = [];
            }

            if (this._recognizeStream.write(chunk)) {
                this._scheduleWriteAudioToRecognizer();
            } else {
                this._recognizeStream.once("drain", this._scheduleWriteAudioToRecognizer);
            }

            if (chunk === AUDIO_SILENCE_CHUNK) {
                this._writeSilenceToAudioBuffer(secondsElapsed);
            } else {
                this._writeToAudioBuffer(chunk);
            }
        } else {
            console.log("recognizeStream does not exist");
            this._scheduleWriteAudioToRecognizer();
        }
    }

    _writeToAudioBuffer(chunk) {
        let writeSize = Math.min(chunk.length, AUDIO_BUFFER_SIZE);
        if (writeSize < AUDIO_BUFFER_SIZE) {
            this._audioBuffer.copy(this._audioBuffer, 0, writeSize, AUDIO_BUFFER_SIZE);
        }

        chunk.copy(
            this._audioBuffer,
            AUDIO_BUFFER_SIZE - writeSize,
            chunk.length - writeSize,
            chunk.length
        );

        this._audioBufferLength = Math.min(this._audioBufferLength + writeSize, AUDIO_BUFFER_SIZE);
    }

    _writeSilenceToAudioBuffer(seconds) {
        if (!seconds) {
            let now = Date.now();
            seconds = (now - this._silentTimestamp) / 1000;
            this._silentTimestamp = now;
        }

        let writeSize = Math.min(AUDIO_BYTES_PER_SECOND * seconds, AUDIO_BUFFER_SIZE);
        writeSize -= writeSize % AUDIO_SINGLE_SAMPLE_BYTES;

        if (writeSize < AUDIO_BUFFER_SIZE) {
            this._audioBuffer.copy(this._audioBuffer, 0, writeSize, AUDIO_BUFFER_SIZE);
        }

        this._audioBuffer.fill(0, AUDIO_BUFFER_SIZE - writeSize);
        this._audioBufferLength = Math.min(this._audioBufferLength + writeSize, AUDIO_BUFFER_SIZE);
    }

    _onSpeechRecognized(data) {
        let transcript =
            data.results[0] &&
            data.results[0].alternatives[0] &&
            data.results[0].alternatives[0].transcript;

        if (transcript) {
            this.emit("transcribe", transcript, data.results[0].isFinal);
        }
    }

    _onAudioReceived(chunk) {
        if (!this._recognizeStream) {
            this._start();
        }

        this._scheduleEndAudioRecognizer();
        this._audioChunkQueue.push(chunk);
    }
}