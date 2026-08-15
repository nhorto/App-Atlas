// Where the status lives. The whole point of #265 is that it lives *here* and not in the
// file doing the refusing — so the evidence has to be followed one hop or it is a class
// name, and a class name is what the top of `auth.ts` spends a hundred lines warning
// about.
export class AuthenticationError extends Error {
  status: number;

  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
    this.status = 401;
  }
}

// The discriminator, and the reason this rule is about a code rather than a spelling.
// Same file, same shape, same `Error` suffix, and it is not a refusal — it is a bad
// request. mastodon has exactly this pair, and a rule reading names would take both.
export class RequestError extends Error {
  status: number;

  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = 400;
  }
}
