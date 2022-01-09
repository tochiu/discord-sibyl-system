import * as fs from "fs";
import * as path from "path";
import { Client, Intents } from "discord.js";
import { SpeechClient } from "@google-cloud/speech";

import GuildManager from "./structures/GuildManager.js";
import CommandAction from "./structures/CommandAction.js";

// attempt to dynamically load environment variables from dotenv
try {
    (await import("dotenv")).config();
} catch (e) {
    console.error(e);
    if (process.env.NODE_ENV !== "production") {
        console.warn("Failed to environment variables from dotenv. This isn't an issue if they are loaded in from elsewhere.");
    }
}

// catch exceptions to keep process alive
process.on("uncaughtException", console.error);

// dynamically import and store a map of commands
const commands = new Map(
    (
        await Promise.all(
            (await fs.promises.readdir("./commands"))
                .filter(file => file.endsWith(".js")) // TODO: remove if necessary
                .map(file => import("file://" + path.resolve("./commands", file)))
        )
    )
    .map(module => [module.default.data.name, module.default])
);

// instantiate the client with proper gateway intents
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_VOICE_STATES] });

// options object that will be passed into every guild manager
const defaultGuildManagerOptions = {

    client,
    speechClient: new SpeechClient(),

    // set on client ready
    ownerTag: undefined,

    // extract and build slash command data from commands
    slashCommandsData: Array.from(commands.values()).map(command => {
        const { name, description, type, options, defaultPermission } = command.data;
        return { name, description, type, options, defaultPermission };
    }),
};

// connect to client events

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // set ownerTag
    defaultGuildManagerOptions.ownerTag = (await client.application.fetch()).owner.tag;

    // register all guilds in cache
    console.log("Registering Guilds");
    for (const guild of client.guilds.cache.values()) {
        GuildManager.register(guild, defaultGuildManagerOptions);
    }
});

client.on("error", console.error);

client.on("guildCreate", guild => GuildManager.register(guild, defaultGuildManagerOptions));
client.on("guildDelete", guild => GuildManager.unregister(guild));

client.on("voiceStateUpdate", async (oldState, newState) => {
    let manager = GuildManager.managers.get(newState.guild.id);
    if (manager) {
        manager.updateMemberVoiceState(oldState, newState);
    }
});

client.on("interactionCreate", async interaction => {
    // we only care about human users sending valid commands from availble guilds
    // TODO: give response on failed checks that are possible to respond to
    if (interaction.member.user.bot
        || !interaction.isCommand()
        || !commands.has(interaction.commandName)
        || !interaction.inGuild()
        || !interaction.guild.available
        || !GuildManager.managers.has(interaction.guildId)

    ) {
        return;
    }
    
    const action = new CommandAction(interaction, GuildManager.managers.get(interaction.guildId));

    // run command with given action
    try {
        await commands.get(interaction.commandName).execute(action);
    } catch (e) {
        console.error("command execution error");
        console.error(e);

        action.updateReply({
            content: "Yikes! :scream: Somethin' went **horribly** wrong tryna run this command!"
                + `Might wanna contact **\`${defaultGuildManagerOptions.ownerTag}\`** about this.`,
            ephemeral: true
        });
    }
});

// login
//console.log("Logging in...");
client.login(process.env.TOKEN);