import type { AgentMessage, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

export type ClientRole = "controller" | "viewer";

export interface ApiModelInfo {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ApiListModelsResponse {
	models: ApiModelInfo[];
}

export interface ApiListReposResponse {
	repos: string[];
}

export interface ApiImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ApiSessionCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	executeImmediately?: boolean;
}

export interface ApiAddRepoRequest {
	cwd: string;
}

export interface ApiActiveSessionsResponse {
	sessions: ApiSessionSummary[];
}

export interface ApiErrorResponse {
	error: string;
}

export interface ApiSessionSummary {
	id: string;
	path: string | null;
	cwd: string;
	name?: string;
	firstMessage: string;
	created: string;
	modified: string;
	messageCount: number;
	isRunning: boolean;
}

export interface ApiListSessionsResponse {
	sessions: ApiSessionSummary[];
}

export interface ApiCreateSessionRequest {
	clientId?: string;
	cwd?: string;
	resumeSessionPath?: string;
	forceNew?: boolean;
}

export interface ApiCreateSessionResponse {
	sessionId: string;
}

export interface ApiContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ApiSessionStats {
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
}

export interface ApiSessionState {
	sessionId: string;
	cwd: string;
	sessionFile: string | null;
	sessionName?: string;
	isStreaming: boolean;
	model: { provider: string; id: string; name?: string } | null;
	thinkingLevel: string;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	stats: ApiSessionStats | null;
	contextUsage: ApiContextUsage | null;
	messages: AgentMessage[];
	commands: ApiSessionCommand[];
}

export interface ApiAskQuestion {
	id: string;
	question: string;
	description?: string;
	options: Array<{ label: string }>;
	multi?: boolean;
	recommended?: number;
}

export interface ApiAskSelection {
	selectedOptions: string[];
	customInput?: string;
}

export type ApiCommandRequest =
	| { type: "prompt"; clientId: string; text: string; images?: ApiImageContent[]; deliverAs?: "followUp" | "steer" }
	| { type: "bash"; clientId: string; command: string; excludeFromContext?: boolean }
	| { type: "abort_bash"; clientId: string }
	| { type: "compact"; clientId: string; customInstructions?: string }
	| { type: "ask_response"; clientId: string; askId: string; cancelled?: boolean; selections: ApiAskSelection[] }
	| { type: "ui_response"; clientId: string; uiId: string; cancelled?: boolean; value?: string }
	| { type: "abort"; clientId: string }
	| { type: "set_model"; clientId: string; provider: string; modelId: string }
	| { type: "set_thinking_level"; clientId: string; level: string }
	| { type: "set_steering_mode"; clientId: string; mode: "all" | "one-at-a-time" }
	| { type: "set_follow_up_mode"; clientId: string; mode: "all" | "one-at-a-time" }
	| { type: "set_session_name"; clientId: string; name: string };

export interface ApiSessionPatch {
	isStreaming?: boolean;
	model?: ApiSessionState["model"];
	thinkingLevel?: string;
	sessionName?: string;
	steeringMode?: ApiSessionState["steeringMode"];
	followUpMode?: ApiSessionState["followUpMode"];
	stats?: ApiSessionState["stats"];
	contextUsage?: ApiSessionState["contextUsage"];
	commands?: ApiSessionCommand[];
}

export interface ApiOkResponse {
	ok: true;
}

export interface ApiTakeoverRequest {
	clientId: string;
}

export interface ApiReleaseRequest {
	clientId: string;
}

export type SseEvent =
	| {
			type: "init";
			state: ApiSessionState;
			yourClientId: string;
			controllerClientId: string | null;
			role: ClientRole;
	  }
	| { type: "agent_event"; event: AgentSessionEvent }
	| { type: "state_patch"; patch: ApiSessionPatch }
	| { type: "controller_changed"; controllerClientId: string | null }
	| { type: "released"; byClientId: string }
	| { type: "ask_request"; askId: string; questions: ApiAskQuestion[] }
	| { type: "ui_select"; uiId: string; title: string; options: string[] }
	| { type: "ui_input"; uiId: string; title: string; placeholder?: string }
	| { type: "ui_confirm"; uiId: string; title: string; message: string }
	| { type: "ui_notify"; message: string; level: "info" | "warning" | "error" };
