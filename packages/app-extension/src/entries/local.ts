import { localAppConfig } from '../apps/local.js';
import poseModel from 'virtual:twrmc-pose-model';

import { installPoseModel } from '../pose-model.js';
import { registerAppShell } from '../register.js';

// Before the shell registers, so the model is in place before any script can start the pipeline.
installPoseModel(poseModel);
registerAppShell(localAppConfig);
