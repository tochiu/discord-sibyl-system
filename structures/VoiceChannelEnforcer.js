import { promisify } from "util";
import { EventEmitter } from "events";
import { Lame } from "node-lame";
import { opus } from 'prism-media';
import {
	EndBehaviorType,
	entersState,
	VoiceConnectionDisconnectReason,
	VoiceConnectionStatus
} from "@discordjs/voice";

import VoiceAnalyzer from "./VoiceAnalyzer.js";
import { AUDIO_CLIP_SECONDS } from "../config.js";

const wait = promisify(setTimeout);

const AUDIO_CLIP_EXPORT_CONFIG = {
	output: "buffer",
	bitrate: 64,
	raw: true,
	sfreq: 48,
	bitwidth: 16,
	signed: true,
	"little-endian": true,
};

/**
 * A MusicPlayer exists for each active VoiceConnection. Each subscription has its own audio player and queue,
 * and it also attaches logic to the audio player and voice connection for error handling and reconnection logic.
 */
export default class VoiceChannelEnforcer extends EventEmitter {

	_readyLock = false;

	_voiceData = new Map();
	_voiceDataExpiring = new Map();

	constructor(voiceConnection, speechClient) {
		super();

		this.channelId = voiceConnection.joinConfig.channelId;

		this._speechClient = speechClient;

		this._voiceConnection = voiceConnection;
		this._voiceConnection.on("stateChange", async (_, state) => {
			if (state.status === VoiceConnectionStatus.Disconnected) {
				if (state.reason === VoiceConnectionDisconnectReason.WebSocketClose && state.closeCode === 4014) {
					/*
						If the WebSocket closed with a 4014 code, this means that we should not manually attempt to reconnect,
						but there is a chance the connection will recover itself if the reason of the disconnect was due to
						switching voice channels. This is also the same code for the bot being kicked from the voice channel,
						so we allow 5 seconds to figure out which scenario it is. If the bot has been kicked, we should destroy
						the voice connection.
					*/
					try {
						/* Probably moved voice channel */
						await entersState(this._voiceConnection, VoiceConnectionStatus.Connecting, 5000);
					} catch {
						/* Probably removed from voice channel */
						this._voiceConnection.destroy();
					}
				} else if (this._voiceConnection.rejoinAttempts < 5) {
					/*
						The disconnect in this case is recoverable, and we also have <5 repeated attempts so we will reconnect.
					*/
					await wait((this._voiceConnection.rejoinAttempts + 1) * 5000);
					this._voiceConnection.rejoin();
				} else {
					/*
						The disconnect in this case may be recoverable, but we have no more remaining attempts - destroy.
					*/
					this._voiceConnection.destroy();
				}
			} else if (state.status === VoiceConnectionStatus.Destroyed) {
				/*
					Once destroyed, stop the subscription and emit the disconnect event
				*/
				this.emit("disconnect");
			} else if (
				!this._readyLock &&
				(state.status === VoiceConnectionStatus.Connecting || state.status === VoiceConnectionStatus.Signalling)
			) {
				/*
					In the Signalling or Connecting states, we set a 20 second time limit for the connection to become ready
					before destroying the voice connection. This stops the voice connection permanently existing in one of these
					states.
				*/
				this._readyLock = true;
				try {
					await entersState(this._voiceConnection, VoiceConnectionStatus.Ready, 20000);
				} catch {
					if (this._voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
						this._voiceConnection.destroy();
					}
				} finally {
					this._readyLock = false;
				}
			}
		});
	}

	destroy() {
		console.log("Destroying channel enforcer");
		this.removeAllListeners();

		if (this._voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
			this._voiceConnection.destroy();
		}

		for (const [userId, voiceData] of this._voiceData) {
			this._voiceData.delete(userId);
			this._cleanVoiceData(voiceData);
		}

		for (const [userId, voiceData] of this._voiceDataExpiring) {
			clearTimeout(voiceData.timeoutId);
			this._voiceDataExpiring.delete(userId);
			this._cleanVoiceData(voiceData);
		}
	}

	isEnforcingMember(member) {
		return this._voiceData.has(member.user.id);
	}

	enforceMember(member, phraseSets) {
		const userId = member.user.id;
		const voiceData = this._voiceDataExpiring.get(userId);

		if (voiceData) {
			clearTimeout(voiceData.timeoutId);			
			this._voiceDataExpiring.delete(userId);
			this._voiceData.set(userId, voiceData);
			voiceData.timeoutId = undefined;
		} else {
			// subscribe to an audio given user and pipe the returning opus stream to the decoder
			const stream = this._voiceConnection.receiver.subscribe(userId, {
				end: { behavior: EndBehaviorType.Manual },
			});

			// create opus stream decoder (opus->pcm)
			const decoder = new opus.Decoder({ channels: 2, rate: 48000, frameSize: 960 });

			stream.pipe(decoder);

			// analyze the decoded stream with the given phrase sets and speech-to-text client
			const analyzer = new VoiceAnalyzer(phraseSets, this._speechClient, decoder);

			analyzer.on("transcribe", data => {
				console.log(`<${member.displayName}>: "${data}"`);
			});

			analyzer.on("transcribe", data => {
				for (const phraseSet of phraseSets) {
					const words = phraseSet.getPhraseSlice(data);
					if (words) {
						console.log("phrase identified");
						this.emit("identify", member, words.join(" "));
					}
				}
			});

			this._voiceData.set(userId, { userId, stream, decoder, analyzer, timeoutId: undefined });
		}
	}

	foregoMember(member) {
		const userId = member.user.id;
		const voiceData = this._voiceData.get(userId);

		if (voiceData) {
			this._voiceData.delete(userId);
			this._voiceDataExpiring.set(userId, voiceData);

			voiceData.timeoutId = setTimeout(() => {
				this._voiceDataExpiring.delete(userId);
				this._cleanVoiceData(voiceData);
			}, AUDIO_CLIP_SECONDS * 1000)
		}
	}

	async clip() {

		const analyzers = this._voiceData.values().concat(this._voiceDataExpiring.keys()).map(voiceData => voiceData.analyzer);

		const audioBuffers = analyzers.map(analyzer => analyzer.getAudioBuffer());
		const audioBufferLengths = analyzers.map(analyzer => analyzer.getAudioBufferLength());

		const clipBufferSize = audioBufferLengths.reduce(Math.max, 0);
		const clipBuffer = Buffer.alloc(clipBufferSize, 0);

		for (let offset = 0; offset < clipBufferSize; offset += 2) {
			let clipSample = 0;
			for (const buffer of audioBuffers) {
				clipSample += buffer.readInt16LE(buffer.length - clipBufferSize + offset); // LINEAR16 encoding assumed => readInt16LE
			}

			clipBuffer.writeInt16LE(Math.round(clipSample / audioBuffers.length), offset);
		}

		const encoder = new Lame(AUDIO_CLIP_EXPORT_CONFIG).setBuffer(clipBuffer);

		return encoder.encode().then(() => encoder.getBuffer());
	}

	_cleanVoiceData(voiceData) {
		voiceData.stream.destroy();
		voiceData.decoder.destroy();
		voiceData.analyzer.destroy();
	}
}