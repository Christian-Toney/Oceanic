import SequentialBucket from "./SequentialBucket";
import DiscordRESTError from "./DiscordRESTError";
import DiscordHTTPError from "./DiscordHTTPError";
import type { RESTMethod } from "../Constants";
import { BASE_URL, RESTMethods, USER_AGENT } from "../Constants";
import TypedEmitter from "../util/TypedEmitter";
import Base from "../structures/Base";
import Properties from "../util/Properties";
import type Client from "../Client";
import type { Agent } from "undici";
import { FormData, fetch, File as UFile } from "undici";
import { assert } from "tsafe";

/**
 * Latency & ratelimit related things lovingly borrowed from eris
 * https://github.com/abalabahaha/eris/blob/dev/lib/rest/RequestHandler.js
 */

export default class RequestHandler extends TypedEmitter<RequestEvents> {
	private _client: Client;
	globalBlock = false;
	latencyRef: LatencyRef;
	options: InstanceOptions;
	ratelimits: Record<string, SequentialBucket> = {};
	readyQueue: Array<() => void> = [];
	/**
	 * Construct an instance of RequestHandler
	 *
	 * @param {RequestHandlerOptions} options - the options for the request handler
	 */
	constructor(client: Client, options: RequestHandlerOptions = {}) {
		super();
		if (options && options.baseURL && options.baseURL.endsWith("/")) options.baseURL = options.baseURL.slice(0, -1);
		Properties.new(this)
			.define("_client", client)
			.define("options", {
				agent:                      options.agent,
				baseURL:                    options.baseURL || BASE_URL,
				disableLatencyCompensation: !!options.disableLatencyCompensation,
				host:                       options.host || options.baseURL ? new URL(this.options.baseURL).host : new URL(BASE_URL).host,
				latencyThreshold:           options.latencyThreshold ?? 30000,
				ratelimiterOffset:          options.ratelimiterOffset ?? 0,
				requestTimeout:             options.requestTimeout ?? 15000,
				userAgent:                  options.userAgent || USER_AGENT
			})
			.define("latencyRef", {

				lastTimeOffsetCheck: 0,
				latency:             options.ratelimiterOffset,
				raw:                 new Array(10).fill(options.ratelimiterOffset),
				timeOffsets:         new Array(10).fill(0),
				timeoffset:          0
			});

	}

	private getRoute(path: string, method: string) {
		let route = path.replace(/\/([a-z-]+)\/(?:[\d]{15,21})/g, function(match, p) {
			return p === "channels" || p === "guilds" || p === "webhooks" ? match : `/${p as string}/:id`;
		}).replace(/\/reactions\/[^/]+/g, "/reactions/:id").replace(/\/reactions\/:id\/[^/]+/g, "/reactions/:id/:userID").replace(/^\/webhooks\/(\d+)\/[A-Za-z0-9-_]{64,}/, "/webhooks/$1/:token");
		if (method === "DELETE" && route.endsWith("/messages/:id")) {
			const messageID = path.slice(path.lastIndexOf("/") + 1);
			const createdAt = Base.getCreatedAt(messageID);
			if (Date.now() - this.latencyRef.latency - createdAt >= 1000 * 60 * 60 * 24 * 14) method += "_OLD";
			else if (Date.now() - this.latencyRef.latency - createdAt <= 1000 * 10) method += "_NEW";
			route = method + route;
		} else if (method === "GET" && /\/guilds\/[0-9]+\/channels$/.test(route)) {
			route = "/guilds/:id/channels";
		}
		if (method === "PUT" || method === "DELETE") {
			const index = route.indexOf("/reactions");
			if (index !== -1) route = "MODIFY" + route.slice(0, index + 10);
		}
		return route;
	}

	private globalUnblock() {
		this.globalBlock = false;
		while (this.readyQueue.length > 0) this.readyQueue.shift()!();
	}

	/** same as `request`, but with `auth` always set to `true`. */
	async authRequest<T = unknown>(method: RESTMethod, path: string, body?: unknown, files?: Array<File>, reason?: string, priority = false, route?: string) {
		return this.request<T>(method, path, body, files, reason, true, priority, route);
	}

	/**
	 * Make a request
	 *
	 * @template T
	 * @param {RESTMethod} method - he method of this request
	 * @param {String} path - the path of this request - will be combined with baseURL
	 * @param {Object} [body] - the body to send with the request
	 * @param {File[]} [files] - the files to send with this request
	 * @param {String} [reason] - the value to pass in `X-Audit-Log-Reason`, if applicable
	 * @param {(Boolean | String)} [auth=false] - true to use global auth if specified, false for no auth, and a string value for specific authorization (must be prefixed)
	 * @param {Boolean} [priority=false] - if this request should be considered a priority
	 * @param {String} [route] - the route path (with placeholders)
	 * @returns {Promise<T>} - The result body, null if no content
	 */
	async request<T = unknown>(method: RESTMethod, path: string, body?: unknown, files?: Array<File>, reason?: string, auth: boolean | string = false, priority = false, route?: string) {
		// eslint-disable-next-line prefer-rest-params
		const args = [...arguments] as Parameters<RequestHandler["request"]>;
		assert(method && typeof method === "string", "method is required for RequestHandler#reqest");
		method = method.toUpperCase() as RESTMethod;
		if (!RESTMethods.includes(method)) throw new Error(`Invalid method "${method}.`);
		assert(path, "path is required for RequestHandler#reqest");
		const _stackHolder = {};
		Error.captureStackTrace(_stackHolder);
		if (!path.startsWith("/")) path = `/${path}`;
		if (!route) route = this.getRoute(path, method);
		if (!this.ratelimits[route]) this.ratelimits[route] = new SequentialBucket(1, this.latencyRef);
		let attempts = 0;
		return new Promise<T>((resolve, reject) => {
			async function attempt(this: RequestHandler, cb: () => void) {
				const headers: Record<string, string> = {};
				try {
					if (typeof auth === "string") headers.Authorization = auth;
					else if (auth && this._client.options.auth) headers.Authorization = this._client.options.auth;
					if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);

					let reqBody: string | FormData | undefined;
					if (method !== "GET") {
						let stringBody: string | undefined;
						if (body) stringBody = JSON.stringify(body, (k, v: unknown) => typeof v === "bigint" ? v.toString() : v);
						if (files && files.length > 0) {
							const data = new FormData();
							files.forEach((file, index) => {
								if (!file.contents) return;
								data.set(`files[${index}]`, new UFile([file.contents], file.name));
							});
							if (stringBody) data.set("payload_json", stringBody);
							reqBody = data;
						} else if (body) {
							reqBody = stringBody;
							headers["Content-Type"] = "application/json";
						}
					}

					if (this.options.host) headers.Host = this.options.host;
					const url = `${this.options.baseURL}${path}`;
					let latency = Date.now();
					const controller = new AbortController();
					let timeout: NodeJS.Timeout | undefined;
					if (this.options.requestTimeout > 0 && this.options.requestTimeout !== Infinity) timeout = setTimeout(() => controller.abort(), this.options.requestTimeout);
					const res = await fetch(url, {
						method,
						headers,
						body:       reqBody,
						dispatcher: this.options.agent,
						signal:     controller.signal
					});
					if (timeout) clearTimeout(timeout);
					latency = Date.now() - latency;
					if (!this.options.disableLatencyCompensation) {
						this.latencyRef.raw.push(latency);
						this.latencyRef.latency = this.latencyRef.latency - ~~(this.latencyRef.raw.shift()! / 10) + ~~(latency / 10);
					}
					let resBody: string | Record<string, unknown> | null;
					if (res.status === 204) resBody = null;
					else {
						const b = await res.text();
						if (res.headers.get("content-type") === "application/json") {
							try {
								resBody = JSON.parse(b) as Record<string, unknown>;
							} catch (err) {
								this.emit("error", err as Error);
								resBody = b;
							}
						} else resBody = b;
					}
					assert(route);
					if (this.listeners("request").length) {
						this.emit("request", {
							method,
							path,
							route,
							withAuth:     !!auth,
							requestBody:  reqBody,
							responseBody: resBody
						});
					}
					const headerNow = Date.parse(res.headers.get("date")!);
					const now = Date.now();
					if (this.latencyRef.lastTimeOffsetCheck < (Date.now() - 5000)) {
						const timeOffset = headerNow + 500 - (this.latencyRef.lastTimeOffsetCheck = Date.now());
						if (this.latencyRef.timeoffset - this.latencyRef.latency >= this.options.latencyThreshold && timeOffset - this.latencyRef.latency >= this.options.latencyThreshold) {
							this.emit("warn", `Your clock is ${this.latencyRef.timeoffset}ms behind Discord's server clock. Please check your connection and system time.`);
						}
						this.latencyRef.timeoffset = this.latencyRef.timeoffset - ~~(this.latencyRef.timeOffsets.shift()! / 10) + ~~(timeOffset / 10);
						this.latencyRef.timeOffsets.push(timeOffset);
					}
					if (res.headers.has("x-ratelimit-limit")) this.ratelimits[route].limit = Number(res.headers.get("x-ratelimit-limit"));
					if (method !== "GET" && (!res.headers.has("x-ratelimit-remaining") || !res.headers.has("x-ratelimit-limit")) && this.ratelimits[route].limit !== 1) {
						this.emit("debug", [`Missing ratelimit headers for SequentialBucket(${this.ratelimits[route].remaining}/${this.ratelimits[route].limit}) with non-default limit\n`,
							`${res.status} ${res.headers.get("content-type")!}: ${method} ${route} | ${res.headers.get("cf-ray")!}\n`,
							`content-type = ${res.headers.get("content-type")!}\n`,
							`x-ratelimit-remaining = " + ${res.headers.get("x-ratelimit-remaining")!}\n`,
							`x-ratelimit-limit = " + ${res.headers.get("x-ratelimit-limit")!}\n`,
							`x-ratelimit-reset = " + ${res.headers.get("x-ratelimit-reset")!}\n`,
							`x-ratelimit-global = " + ${res.headers.get("x-ratelimit-global")!}`].join("\n"));
					}
					this.ratelimits[route].remaining = !res.headers.has("x-ratelimit-remaining") ? 1 : Number(res.headers.get("x-ratelimit-remaining")) || 0;
					const retryAfter = Number(res.headers.get("x-ratelimit-reset-after") || res.headers.get("retry-after") || 0);
					if (retryAfter >= 0) {
						if (res.headers.has("x-ratelimit-global")) {
							this.globalBlock = true;
							setTimeout(this.globalUnblock.bind(this), retryAfter || 1);
						} else this.ratelimits[route].reset = (retryAfter || 1) + now;
					} else if (res.headers.has("x-ratelimit-reset")) {
						let resetTime = Number(res.headers.get("x-ratelimit-reset")) * 100;
						if (route.endsWith("/reactions/:id") && (resetTime - headerNow) === 1000) resetTime = now + 250;
						this.ratelimits[route].reset = Math.max(resetTime - this.latencyRef.latency, now);
					} else this.ratelimits[route].reset = now;
					if (res.status !== 429 && this.listeners("debug").length) this.emit("debug", `${now} ${route} ${res.status}: ${latency}ms (${this.latencyRef.latency}ms avg) | ${this.ratelimits[route].remaining}/${this.ratelimits[route].limit} left | Reset ${this.ratelimits[route].reset} (${this.ratelimits[route].reset - now}ms left)`);
					if (res.status > 300) {
						if (res.status === 429) {
							let delay = retryAfter;
							if (res.headers.get("x-ratelimit-scope") === "shared") {
								try {
									delay = (resBody as { retry_after: number; }).retry_after;
								} catch (err) {
									reject(err);
								}
							}
							this.emit("debug", `${res.headers.has("x-ratelimit-global") ? "Global" : "Unexpected"} RateLimit: ${JSON.stringify(resBody)}\n${now} ${route} ${res.status}: ${latency}ms (${this.latencyRef.latency}ms avg) | ${this.ratelimits[route].remaining}/${this.ratelimits[route].limit} left | Reset ${delay} (${this.ratelimits[route].reset - now}ms left) | Scope ${res.headers.get("x-ratelimit-scope")!}`);
							if (delay) {
								setTimeout(() => {
									cb();
									// eslint-disable-next-line prefer-rest-params, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, prefer-spread
									this.request<T>(...args).then(resolve).catch(reject);
								}, delay);
							} else {
								cb();
								this.request<T>(...args).then(resolve).catch(reject);
							}
						} else if (res.status === 502 && ++attempts < 4) {
							this.emit("debug", `Unexpected 502 on ${method} ${route}`);
							setTimeout(() => {
								this.request<T>(...args).then(resolve).catch(reject);
							}, Math.floor(Math.random() * 1900 + 100));
							return cb();
						}
						cb();
						let { stack } = _stackHolder as { stack: string; };
						if (stack.startsWith("Error\n")) stack = stack.substring(6);
						let err;
						if (resBody && typeof resBody === "object" && "code" in resBody) {
							err = new DiscordRESTError(res, resBody, method, stack);
						} else {
							err = new DiscordHTTPError(res, resBody, method, stack);
						}
						reject(err);
						return;
					}

					cb();
					resolve(resBody as T);
				} catch (err) {
					if (err instanceof Error && err.constructor.name === "DOMException" && err.name === "AbortError") {
						cb();
						reject(new Error(`Request Timed Out (>${this.options.requestTimeout}ms) on ${method} ${path}`));
					}
					this.emit("error", err as Error);
				}
			}
			if (this.globalBlock && auth) {
				(priority ? this.readyQueue.unshift.bind(this.readyQueue) : this.readyQueue.push.bind(this.readyQueue))(() => {
					this.ratelimits[route!].queue(attempt.bind(this), priority);
				});
			} else this.ratelimits[route!].queue(attempt.bind(this), priority);
		});
	}
}


export interface RequestHandlerOptions {
	agent?: Agent | null;
	/** the base url for requests - must be fully qualified (default: `https://discord.com/api/v[REST_VERSION]`) */
	baseURL?: string;
	/** If the built in latency compensator should be disabled (default: false) */
	disableLatencyCompensation?: boolean;
	/** the host to use with requests (default: domain from `baseURL`) */
	host?: string;
	/** in milliseconds, the average request latency at which to start emitting latency errors (default: 30000) */
	latencyThreshold?: number;
	/** in milliseconds, the time to offset ratelimit calculations by (default: 0) */
	ratelimiterOffset?: number;
	/** in milliseconds, how long to wait until a request is timed out (default: 15000) */
	requestTimeout?: number;
	/** the user agent to use for requests (default: `Oceanic/VERSION (https://github.com/DonovanDMC/Oceanic)`) */
	userAgent?: string;
}

// internal use
interface InstanceOptions extends Required<Omit<RequestHandlerOptions, "agent">> {
	agent?: Agent;
}

export interface File {
	/** the contents of the file */
	contents: Buffer;
	/** the name of the file */
	name: string;
}

export interface RawRequest {
	/** the method of the request */
	method: RESTMethod;
	/** the path of the request */
	path: string;
	/** the body sent with the request */
	requestBody: string | FormData | undefined;
	/** the body we recieved */
	responseBody: string | Record<string, unknown> | null;
	/** the name of the route used in the request */
	route: string;
	/** if the request used authorization */
	withAuth: boolean;
}

export interface RequestEvents {
	debug: [info: string];
	error: [err: Error];
	request: [rawRequest: RawRequest];
	warn: [info: string];
}

export interface LatencyRef {
	lastTimeOffsetCheck: number;
	latency: number;
	raw: Array<number>;
	timeOffsets: Array<number>;
	timeoffset: number;
}