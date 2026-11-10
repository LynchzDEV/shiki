export class QueueRefusal extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 423 | 429) {
    super(message)
    this.name = 'QueueRefusal'
  }
}
