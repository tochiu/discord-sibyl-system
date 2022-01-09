import { MessageActionRow, MessageButton, Constants } from "discord.js";

/**
 * A CommandAction is a wrapper over CommandInteraction that includes extra information and utilities
 * relevant for the functioning of each command
 */
export default class CommandAction {

    _deferring;
    _updatableInteraction;
    _modifyUpdatableInteractionOptions;
    _optionsLast;
    
    constructor(interaction, manager) {
        this.interaction = interaction;
        this.manager = manager;
    }

    // forward subsequent updateReply(options) to call updatableInteraction.update(modifyUpdatableInteractionOptions(options))
    // this is useful for modifying a message when updateReply is called before replying with said message
    // NOTE: if modifyUpdatableInteractionOptions === undefined, updateInteraction.update(options) is instead called
    // TODO: simplify design
    setUpdatableInteraction(updatableInteraction, modifyUpdatableInteractionOptions) {
        this._updatableInteraction = updatableInteraction;
        this._modifyUpdatableInteractionOptions = modifyUpdatableInteractionOptions;
    }

    // update interaction components (if any) to show interaction has expired
    async markInteractionExpired() {
        this.setUpdatableInteraction();

        if (!this._optionsLast?.components.length) {
            return;
        }

        const options = Object.assign({}, this._optionsLast);
        options.components = [
            new MessageActionRow()
                .addComponents(
                    new MessageButton()
                        .setCustomId("interaction_expired")
                        .setLabel("Interaction Expired")
                        .setStyle(Constants.MessageButtonStyles.SECONDARY)
                        .setDisabled(true)
                )
        ];

        return this.updateReply(options);
    }

    // defer reply of interaction
    async deferReply(options) {
        if (this._deferring) {
            throw "Reply already deferred";
        }
        const deferring = this.interaction.deferReply(options);
        this._deferring = deferring;
        return deferring;
    }

    // update reply of interaction (this automatically handles already replied to or deferred interactions)
    async updateReply(options) {
        const { interaction } = this;

        // restructure options to be an object with required parameters
        if (typeof options === "string") {
            options = { content: options };
        }

        options = Object.assign({
            content: " ",
            embeds: [],
            files: [],
            components: [],
            stickers: [],
            attachments: []
        }, options);

        // modify options if modifier exists and can be subsequently be forwarded to an interaction
        if (this._updatableInteraction && this._modifyUpdatableInteractionOptions) {
            options = this._modifyUpdatableInteractionOptions(options);
        }

        // overwrite _optionsLast, await deferReply to complete (if necessary) 
        // and exit if _optionsLast was modified during await (updateReply was called again during await)
        this._optionsLast = options;
        await this._deferring;
        if (this._optionsLast !== options) {
            return;
        }

        // update message
        if (this._updatableInteraction) {
            return this._updatableInteraction.update(options);
        } else if (interaction.replied || interaction.deferred) {
            return interaction.editReply({ ...options, ephemeral: interaction.ephemeral });
        } else {
            return interaction.reply(options);
        }
    }
}