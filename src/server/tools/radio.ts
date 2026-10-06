import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { RadioRpcResponse, RadioStation } from "../../types.js";
import type { RadioService } from "../radio.js";
import type { RobotClient } from "../robot-client.js";

const radioControlActions = ["stop", "pause", "resume", "louder", "quieter", "status"] as const;

const radioSearchParameters = Type.Object({
	query: Type.String({ description: "A genre or style (e.g. jazz, classical, 80s, news) or a station name." }),
	searchBy: Type.Optional(
		StringEnum(["tag", "name"], {
			description: "tag for a genre or style, name for a specific station. Defaults to tag.",
			default: "tag",
		}),
	),
	countryCode: Type.Optional(
		Type.String({ description: "Optional two-letter country code, only when the user asks for a country." }),
	),
	limit: Type.Optional(Type.Number({ description: "Number of stations to return. Defaults to 5, maximum 10." })),
});

const radioPlayParameters = Type.Object({
	stationuuid: Type.String({ description: "Exact stationuuid returned by radio_search." }),
});

const radioControlParameters = Type.Object({
	action: StringEnum([...radioControlActions], {
		description: "stop, pause, resume, louder, quieter, or status (what is playing).",
	}),
});

function describeStation(station: RadioStation): string {
	const details = [station.country, station.tags?.split(",").slice(0, 4).join(", ")].filter(Boolean).join("; ");
	return `${station.name}${details ? ` (${details})` : ""}`;
}

function summarize(result: Exclude<RadioRpcResponse, { ok: false }>): string {
	const volume = `Volume ${Math.round(result.volume * 100)} percent.`;
	if (!result.station) return `The radio is off. ${volume}`;
	return `${result.playing ? "Playing" : "Paused"}: ${describeStation(result.station)}. ${volume}`;
}

export function createRadioTools(robot: RobotClient, radio: RadioService): AgentTool[] {
	const search: AgentTool<typeof radioSearchParameters, RadioStation[]> = {
		name: "radio_search",
		label: "Radio Search",
		description:
			"Search free internet radio stations by genre/style (searchBy tag, the default) or by station name. Returns stations with a stationuuid for radio_play.",
		parameters: radioSearchParameters,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const stations = await radio.search({
				query: params.query.trim().toLowerCase(),
				searchBy: params.searchBy === "name" ? "name" : "tag",
				countryCode: params.countryCode,
				limit: params.limit ?? 5,
			});
			const text =
				stations.length === 0
					? `No playable stations found for ${params.query}. Try a broader genre or searchBy name.`
					: stations.map((station, index) => `${index}: ${describeStation(station)} [${station.uuid}]`).join("\n");
			return { content: [{ type: "text", text }], details: stations };
		},
	};

	const play: AgentTool<typeof radioPlayParameters, RadioRpcResponse> = {
		name: "radio_play",
		label: "Radio Play",
		description: "Play an internet radio station on the user's device, by a stationuuid from radio_search.",
		parameters: radioPlayParameters,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const { station, url } = await radio.prepare(params.stationuuid.trim());
			const result = await robot.execute({
				type: "radio",
				payload: { action: "play", url, station },
				timeoutMs: 20000,
				signal,
			});
			if (!result.ok) throw new Error(result.error);
			return { content: [{ type: "text", text: summarize(result) }], details: result };
		},
	};

	const control: AgentTool<typeof radioControlParameters, RadioRpcResponse> = {
		name: "radio_control",
		label: "Radio Control",
		description: "Stop, pause, resume, make louder or quieter, or check what the radio is playing.",
		parameters: radioControlParameters,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const action = radioControlActions.find((entry) => entry === params.action);
			if (!action) throw new Error(`Unknown radio action: ${params.action}`);
			const result = await robot.execute({ type: "radio", payload: { action }, timeoutMs: 15000, signal });
			if (!result.ok) throw new Error(result.error);
			return { content: [{ type: "text", text: summarize(result) }], details: result };
		},
	};

	return [search, play, control];
}
