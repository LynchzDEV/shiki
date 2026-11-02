export class QueueRefusal extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
    this.name = 'QueueRefusal'
  }
}
