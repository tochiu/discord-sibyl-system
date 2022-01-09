import { promisify } from "util";
import { getVoiceConnection } from "@discordjs/voice";

import PhraseSet from "./PhraseSet.js";
import VoiceChannelEnforcer from "./VoiceChannelEnforcer.js";

const TEST_PHRASE_SETS = [new PhraseSet(["boneless pizza"]), new PhraseSet(["doing your mom"])];
const sleep = promisify(setTimeout);

console.log(TEST_PHRASE_SETS);

export default class GuildManager {

    static managers = new Map();

    static register(guild, options) {
        if (GuildManager.managers.has(guild.id)) {
            return;
        }

        console.log(`Registering Guild "${guild.name}" <${guild.id}>`);
        GuildManager.managers.set(guild.id, new GuildManager(guild, options));
    }

    static unregister(guild) {
        const manager = GuildManager.managers.get(guild.id);
        if (!manager) {
            return;
        }

        console.log(`Unregistering Guild "${guild.name}" <${guild.id}>`);
        GuildManager.managers.delete(guild.id);
        manager.destroy();
    }

    guild;
    client;
    speechClient;
    enforcer;

    _destroyed = false;

    constructor(guild, options) {
        const { slashCommandsData, client, speechClient } = options;

        this.guild = guild;
        this.client = client;
        this.speechClient = speechClient;

        // register guild commands until success or unregistered
        (async () => {
            console.log(`Setting "${guild.name}" commands`);
            while (!this._destroyed) {
                try {
                    await this.guild.commands.set(slashCommandsData);
                    console.log(`Successfully set commands in "${guild.name}"`);
                    return;
                } catch (e) { // retry in 5 seconds on failure
                    console.error(e);
                    await sleep(5000);
                };
            }
        })();
    }

    destroy() {
        this._destroyed = true;
        if (this.enforcer) {
            this.enforcer.destroy();
        }
    }

    shouldEnforceMember(member) {
        return !member.user.bot && member.id !== '231410548216954880'; // TODO: dont hardcode this
    }

    updateClientMemberVoiceState(channel) {
        if (this.enforcer) {
            this.enforcer.destroy();
            this.enforcer = undefined;
        }

        if (!channel) {
            return;
        }

        const voiceConnection = getVoiceConnection(channel.guildId);

        if (channel && voiceConnection.joinConfig.channelId === channel.id) {
            const enforcer = new VoiceChannelEnforcer(voiceConnection, this.speechClient);

            enforcer.on("disconnect", () => {
                if (this.enforcer === enforcer) {
                    this.updateClientMemberVoiceState();
                }
            });

            enforcer.on("identify", (member, phrase) => {
                console.log(`Idenified "${member.displayName}" saying "${phrase}"`);
                member.voice.disconnect(`Said "${phrase}"`);
            });

            this.enforcer = enforcer;

            for (const member of channel.members.filter(member => this.shouldEnforceMember(member)).values()) {
                this.enforcer.enforceMember(member, TEST_PHRASE_SETS);
            }
        }
    }

    updateMemberVoiceState(oldState, newState) {
        const { channelId: oldChannelId } = oldState;
        const { channelId: newChannelId, member } = newState;
        if (newChannelId === oldChannelId) {
            return;
        }

        console.log(member.user.id, this.client.user?.id, newChannelId, this.enforcer?.channelId, this.shouldEnforceMember(member), this.enforcer?.isEnforcingMember(member) )

        if (member.user.id === this.client.user?.id) {
            this.updateClientMemberVoiceState(newState.channel);
        } else if (newChannelId && newChannelId === this.enforcer?.channelId && this.shouldEnforceMember(member)) {
            this.enforcer.enforceMember(member, TEST_PHRASE_SETS);
        } else if (!newChannelId && this.enforcer?.isEnforcingMember(member)) {
            this.enforcer.foregoMember(member);
        }
    }
}