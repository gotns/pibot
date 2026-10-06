import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RadioService } from "../radio.js";
import type { RobotClient } from "../robot-client.js";
import type { MemoryStore } from "./memory.js";
import { createMemoryTool } from "./memory.js";
import { createMotorTools } from "./motor.js";
import { createPhotoTool } from "./photo.js";
import { createRadioTools } from "./radio.js";
import { sleepTool } from "./sleep.js";
import { createSpotifyTools, type SpotifyHandler } from "./spotify.js";
import { pageContentTool, webSearchTool } from "./websearch.js";

export { pruneImagesForContext } from "./context.js";

export function createRobotTools(
	robot: RobotClient,
	memoryStore: MemoryStore,
	spotify: SpotifyHandler,
	radio: RadioService,
): AgentTool[] {
	return [
		...createMotorTools(robot),
		createPhotoTool(robot),
		...createSpotifyTools(spotify),
		...createRadioTools(robot, radio),
		sleepTool,
		...(process.env.BRAVE_API_KEY ? [webSearchTool] : []),
		pageContentTool,
		createMemoryTool(memoryStore),
	];
}
