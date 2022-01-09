class CustomError extends Error {
    constructor(msg, ...args) {
        super(msg);
        this.name = this.constructor.name;
        this.args = args;
        if (typeof Error.captureStackTrace === "function") {
            Error.captureStackTrace(this, this.constructor);
        } else {
            this.stack = new Error(message).stack;
        }
    }
}

export class PermissionsError extends CustomError {
    constructor(...permissions) {
        super(`Missing ${permissions.join(", ")} permissions`);
    }
}