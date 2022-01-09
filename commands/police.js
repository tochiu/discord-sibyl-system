//import { Permissions } from "discord.js";
//import { PermissionsError } from "../errors";
import { joinVoiceChannel } from "@discordjs/voice";

export default {

    data: {
        name: "police",
        description: "test command",
    },

    execute: async action => {
        const channel = action.interaction.member.voice.channel;
        if (!channel) {
            action.updateReply({ content: "get in a channel", ephemeral: true });
            return;
        }

        joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });

        action.updateReply("im here!");

        //const user = action.manager.client.user;
        /* can't enforce if cannot join the requested voice channel */
        //const permissions = channel.permissionsFor(user);
        //if (!permissions || !permissions.has(Permissions.FLAGS.CONNECT) || !permissions.has(Permissions.FLAGS.SPEAK)) {
        //    throw new PermissionsError("CONNECT", "SPEAK");
        //}
    }
};