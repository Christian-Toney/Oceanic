import Base from "./Base";
import Permission from "./Permission";
import type Client from "../Client";
import { ApplicationCommandTypes } from "../Constants";
import type {
	ApplicationCommandOptions,
	ApplicationCommandPermission,
	CombinedApplicationCommandOption,
	EditApplicationCommandPermissionsOptions,
	GuildApplicationCommandPermissions,
	RawApplicationCommand,
	RawApplicationCommandOption,
	TypeToEdit
} from "../types/application-commands";

export default class ApplicationCommand<T extends ApplicationCommandTypes = ApplicationCommandTypes> extends Base {
	applicationID: string;
	defaultMemberPermissions: Permission | null;
	description: T extends ApplicationCommandTypes.CHAT_INPUT ? string : "";
	descriptionLocalizations?: Record<string, string> | null;
	dmPermission?: boolean;
	guildID?: string;
	name: string;
	nameLocalizations?: Record<string, string> | null;
	options?: Array<ApplicationCommandOptions>;
	type?: T;
	version: string;
	constructor(data: RawApplicationCommand, client: Client) {
		super(data.id, client);
		this.update(data);
	}

	protected static _convertOption(option: RawApplicationCommandOption, to: "parsed"): ApplicationCommandOptions;
	protected static _convertOption(option: ApplicationCommandOptions, to: "raw"): RawApplicationCommandOption;
	protected static _convertOption(option: RawApplicationCommandOption | ApplicationCommandOptions, to: "raw" | "parsed") {
		if (to === "raw") {
			const opt = option as unknown as CombinedApplicationCommandOption;
			return {
				autocomplete:              opt.autocomplete,
				channel_types:             opt.channelTypes,
				choices:                   opt.choices,
				description:               opt.description,
				description_localizations: opt.descriptionLocalizations,
				max_length:                opt.maxLength,
				max_value:                 opt.maxValue,
				min_length:                opt.minLength,
				min_value:                 opt.minValue,
				name:                      opt.name,
				name_localizations:        opt.nameLocalizations,
				options: 				              opt.options?.map(o => this._convertOption(o as ApplicationCommandOptions, "raw")),
				required:                  opt.required,
				type:                      opt.type
			} as RawApplicationCommandOption;
		} else if (to === "parsed") {
			const opt = option as RawApplicationCommandOption;
			return {
				autocomplete:             opt.autocomplete,
				channelTypes:             opt.channel_types,
				choices:                  opt.choices,
				description:              opt.description,
				descriptionLocalizations: opt.description_localizations,
				max_length:               opt.max_length,
				max_value:                opt.max_value,
				min_length:               opt.min_length,
				min_value:                opt.min_value,
				name:                     opt.name,
				nameLocalizations:        opt.name_localizations,
				options: 				             opt.options?.map(o => this._convertOption(o, "parsed")),
				required:                 opt.required,
				type:                     opt.type
			} as ApplicationCommandOptions;
		}
	}

	protected update(data: RawApplicationCommand) {
		this.applicationID = data.application_id;
		this.defaultMemberPermissions = data.default_member_permissions ? new Permission(data.default_member_permissions) : null;
		this.description = data.description as never;
		this.descriptionLocalizations = data.description_localizations;
		this.dmPermission = data.dm_permission;
		this.guildID = data.guild_id;
		this.name = data.name;
		this.nameLocalizations = data.name_localizations;
		this.options = data.options?.map(o => ApplicationCommand._convertOption(o, "parsed"));
		this.type = (data.type || ApplicationCommandTypes.CHAT_INPUT) as T;
		this.version = data.version;
	}

	/**
	 * Delete this command.
	 *
	 * @returns {Promise<void>}
	 */
	async delete() {
		return this.guildID ? this._client.rest.applicationCommands.deleteGuildCommand(this.applicationID, this.guildID, this.id) : this._client.rest.applicationCommands.deleteGlobalCommand(this.applicationID, this.id);
	}

	/**
	 * Edit this command.
	 *
	 * @param {Object} options
	 * @param {String?} [options.defaultMemberPermissions] - The default member permissions for the command.
	 * @param {String} [options.description] - The description of the command. `CHAT_INPUT only.
	 * @param {String?} [options.descriptionLocalizations] - A dictionary of [locales](https://discord.com/developers/docs/reference#locales) to localized descriptions. `CHAT_INPUT only.
	 * @param {Boolean?} [options.dmPermission] - If the command can be used in a DM.
	 * @param {String} [options.name] - The name of the command.
	 * @param {Object?} [options.nameLocalizations] - A dictionary of [locales](https://discord.com/developers/docs/reference#locales) to localized names.
	 * @param {Object[]} [options.options] - See [Discord's docs](https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-structure) for more information. Convert `snake_case` keys to `camelCase`. `CHAT_INPUT only.
	 * @returns {Promise<ApplicationCommand>}
	 */
	async edit(options: TypeToEdit<T>) {
		return this.guildID ? this._client.rest.applicationCommands.editGuildCommand(this.applicationID, this.guildID, this.id, options) : this._client.rest.applicationCommands.editGlobalCommand(this.applicationID, this.id, options);
	}

	/**
	 * Edit this command's permissions (guild commands only). This requires a bearer token with the `applications.commands.permissions.update` scope.
	 *
	 * @param {Object} options
	 * @param {String} [options.accessToken] - If the overall authorization of this rest instance is not a bearer token, a bearer token can be supplied via this option.
	 * @param {ApplicationCommandPermission[]} options.permissions - The permissions to set for the command.
	 * @returns {Promise<GuildApplicationCommandPermissions>}
	 */
	async editGuildCommandPermissions(options: EditApplicationCommandPermissionsOptions) {
		if (!this.guildID) throw new Error("editGuildCommandPermissions cannot be used on global commands.");
		return this._client.rest.applicationCommands.editGuildCommandPermissions(this.applicationID, this.guildID, this.id, options);
	}

	/**
	 * Get this command's permissions (guild commands only).
	 *
	 * @returns {Promise<GuildApplicationCommandPermissions>}
	 */
	async getGuildPermission() {
		if (!this.guildID) throw new Error("getGuildPermission cannot be used on global commands.");
		return this._client.rest.applicationCommands.getGuildPermission(this.applicationID, this.guildID, this.id);
	}
}