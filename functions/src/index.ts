import { setGlobalOptions } from 'firebase-functions/v2';

// Region close to New York; small instance cap keeps costs predictable.
setGlobalOptions({ region: 'us-east4', maxInstances: 5 });

export { claimOwner, saveSettings } from './callables/admin.js';
export { saveCarrier, saveBroker } from './callables/reference.js';
export { saveClient, savePolicy, reassignPolicies } from './callables/book.js';
export { stageImport, commitImport, undoImport, discardImport } from './callables/imports.js';
export { registerStatementUpload, processStatement, setStatementPayer, discardStatement, getStatementFileUrl } from './callables/statements.js';
export { checkAiConnection } from './callables/ai.js';
