import { login } from '../producer.mjs';
export async function run() { return login().accessToken; }
