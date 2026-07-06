package com.muchucraft.bridge;

/** An error that maps straight to an HTTP status + {"error": message} body. */
final class ApiError extends RuntimeException {
    final int status;

    ApiError(int status, String message) {
        super(message);
        this.status = status;
    }
}
