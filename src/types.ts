import type { Context } from 'hono';

export type Role = 'user' | 'admin';
export type UserStatus = 'active' | 'disabled' | 'invited';
export type Scope = 'read' | 'write' | 'admin';
export type Via = 'session' | 'token' | 'breakglass';

export type Principal = {
	/** null only for the break-glass key. */
	userId: string | null;
	role: Role;
	via: Via;
	scopes: ReadonlySet<Scope>;
	/** role is admin AND the credential carries the admin scope. */
	isAdmin: boolean;
	sessionId?: string;
	tokenId?: string;
};

export type AppEnv = {
	Bindings: Env;
	Variables: {
		principal: Principal | null;
		requestId: string;
	};
};

export type AppContext = Context<AppEnv>;
