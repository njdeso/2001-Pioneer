import { setGlobalOptions } from 'firebase-functions/v2';

// Region close to New York; small instance cap keeps costs predictable.
setGlobalOptions({ region: 'us-east4', maxInstances: 5 });

export { claimOwner, saveSettings } from './callables/admin.js';
export { saveCarrier, saveBroker } from './callables/reference.js';
export { saveClient, savePolicy, reassignPolicies } from './callables/book.js';
