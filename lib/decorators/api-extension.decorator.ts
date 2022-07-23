import { clone } from 'lodash';
import { DECORATORS } from '../constants';
import { createExtendedMixedDecorator } from './helpers';

export function ApiExtension(extensionKey: string, extensionProperties: any) {
  if (!extensionKey.startsWith('x-')) {
    throw new Error(
      'Extension key is not prefixed. Please ensure you prefix it with `x-`.'
    );
  }

  const extensionObject = {
    [extensionKey]: clone(extensionProperties)
  };

  return createExtendedMixedDecorator(DECORATORS.API_EXTENSION, extensionObject);
}
