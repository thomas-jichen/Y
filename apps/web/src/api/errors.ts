import type { ApiError } from './types'

export class HttpError extends Error {
  status: number
  body: ApiError
  constructor(status: number, body: ApiError) {
    super(body.error.message)
    this.status = status
    this.body = body
  }
  get code() {
    return this.body.error.code
  }
}
