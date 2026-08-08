export class ReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewInputError";
  }
}

export class EmptyReviewInputError extends ReviewInputError {
  constructor() {
    super("The selected review target has no changes.");
    this.name = "EmptyReviewInputError";
  }
}

export class OversizedReviewInputError extends ReviewInputError {
  constructor(bytes: number, lines: number, maxBytes: number, maxLines: number) {
    super(
      `Frozen review input is too large (${bytes} bytes, ${lines} lines; ` +
        `limits: ${maxBytes} bytes or ${maxLines} lines). Split the review target.`,
    );
    this.name = "OversizedReviewInputError";
  }
}
