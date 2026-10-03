/** Fachlicher Fehler mit deutscher Meldung für die Oberfläche. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
