import type RESTManager from "../rest/RESTManager";
import Properties from "../util/Properties";

export default abstract class BaseRoute {
	protected _manager: RESTManager;
	constructor(manager: RESTManager) {
		Properties.define(this, "_manager", manager);
	}

	// client is private, so we have to use [] to access it
	protected get _client() { return this._manager["_client"]; }
}