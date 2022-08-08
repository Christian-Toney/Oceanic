import Base from "./Base";
import type { Permission as PermissionNames } from "../Constants";
import { Permissions } from "../Constants";
import Properties from "../util/Properties";

export default class Permission {
	private _json: Record<keyof typeof Permissions, boolean> | undefined;
	allow: bigint;
	deny: bigint;
	constructor(allow: bigint | string, deny: bigint | string = 0n) {
		this.allow = BigInt(allow);
		this.deny = BigInt(deny);
		Properties.define(this, "_json", undefined, true);
	}

	/** A key-value map of permission to if it's been allowed or denied (not present if neither) */
	get json() {
		if (!this._json) {
			const json = {} as Record<keyof typeof Permissions, boolean>;
			for (const perm of Object.keys(Permissions) as Array<keyof typeof Permissions>) {
				if (this.allow & Permissions[perm]) json[perm] = true;
				else if (this.deny & Permissions[perm]) json[perm] = false;
			}
			return (this._json = json);
		} else return this._json;
	}

	/**
	 *Check if this permissions instance has the given permissions allowed
	 *
	 * @param {...PermissionNames} permissions - The permissions to check for.
	 * @returns {Boolean}
	 */
	has(...permissions: Array<PermissionNames>) {
		for (const perm of permissions) {
			if (!(this.allow & Permissions[perm])) return false;
		}
		return true;
	}

	toJSON(props: Array<string> = []) {
		return Base.prototype.toJSON.call(this, ["allow", "deny", ...props]);
	}

	toString() {
		return `[${this.constructor.name} +${this.allow} -${this.deny}]`;
	}
}