/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 * @format
 */

'use strict';

const {
  capitalize,
  getSafePropertyName,
  getNamespacedStructName,
} = require('../Utils');

import type {StructTypeAnnotation, RegularStruct} from '../StructCollector';
import type {StructSerilizationOutput} from './serializeStruct';

const StructTemplate = ({
  moduleName,
  structName,
  structProperties,
}: $ReadOnly<{|
  moduleName: string,
  structName: string,
  structProperties: string,
|}>) => `
namespace JS {
  namespace Native${moduleName} {
    struct ${structName} {
      ${structProperties}

      ${structName}(NSDictionary *const v) : _v(v) {}
    private:
      NSDictionary *_v;
    };
  }
}

@interface RCTCxxConvert (Native${moduleName}_${structName})
+ (RCTManagedPointer *)JS_Native${moduleName}_${structName}:(id)json;
@end
`;

const MethodTemplate = ({
  returnType,
  returnValue,
  moduleName,
  structName,
  propertyName,
}: $ReadOnly<{|
  returnType: string,
  returnValue: string,
  moduleName: string,
  structName: string,
  propertyName: string,
|}>) => `
inline ${returnType}JS::Native${moduleName}::${structName}::${propertyName}() const
{
  id const p = _v[@"${propertyName}"];
  return ${returnValue};
}
`;

function toObjCType(
  moduleName: string,
  typeAnnotation: StructTypeAnnotation,
  isOptional: boolean = false,
): string {
  const isRequired = !typeAnnotation.nullable && !isOptional;
  const wrapFollyOptional = (type: string) => {
    return isRequired ? type : `folly::Optional<${type}>`;
  };

  switch (typeAnnotation.type) {
    case 'ReservedFunctionValueTypeAnnotation':
      switch (typeAnnotation.name) {
        case 'RootTag':
          return wrapFollyOptional('double');
        default:
          (typeAnnotation.name: empty);
          throw new Error(`Unknown prop type, found: ${typeAnnotation.name}"`);
      }
    case 'StringTypeAnnotation':
      return 'NSString *';
    case 'NumberTypeAnnotation':
      return wrapFollyOptional('double');
    case 'FloatTypeAnnotation':
      return wrapFollyOptional('double');
    case 'Int32TypeAnnotation':
      return wrapFollyOptional('double');
    case 'DoubleTypeAnnotation':
      return wrapFollyOptional('double');
    case 'BooleanTypeAnnotation':
      return wrapFollyOptional('bool');
    case 'GenericObjectTypeAnnotation':
      return isRequired ? 'id<NSObject> ' : 'id<NSObject> _Nullable';
    case 'ArrayTypeAnnotation':
      if (typeAnnotation.elementType == null) {
        return isRequired ? 'id<NSObject> ' : 'id<NSObject> _Nullable';
      }
      return wrapFollyOptional(
        `facebook::react::LazyVector<${toObjCType(
          moduleName,
          typeAnnotation.elementType,
        )}>`,
      );
    case 'TypeAliasTypeAnnotation':
      const structName = capitalize(typeAnnotation.name);
      const namespacedStructName = getNamespacedStructName(
        moduleName,
        structName,
      );
      return wrapFollyOptional(namespacedStructName);
    default:
      (typeAnnotation.type: empty);
      throw new Error(
        `Couldn't convert into ObjC type: ${typeAnnotation.type}"`,
      );
  }
}

function toObjCValue(
  moduleName: string,
  typeAnnotation: StructTypeAnnotation,
  value: string,
  depth: number,
  isOptional: boolean = false,
): string {
  const isRequired = !typeAnnotation.nullable && !isOptional;
  const RCTBridgingTo = (type: string, arg?: string) => {
    const args = [value, arg].filter(Boolean).join(', ');
    return isRequired
      ? `RCTBridgingTo${type}(${args})`
      : `RCTBridgingToOptional${type}(${args})`;
  };

  switch (typeAnnotation.type) {
    case 'ReservedFunctionValueTypeAnnotation':
      switch (typeAnnotation.name) {
        case 'RootTag':
          return RCTBridgingTo('Double');
        default:
          (typeAnnotation.name: empty);
          throw new Error(
            `Couldn't convert into ObjC type: ${typeAnnotation.type}"`,
          );
      }
    case 'StringTypeAnnotation':
      return RCTBridgingTo('String');
    case 'NumberTypeAnnotation':
      return RCTBridgingTo('Double');
    case 'FloatTypeAnnotation':
      return RCTBridgingTo('Double');
    case 'Int32TypeAnnotation':
      return RCTBridgingTo('Double');
    case 'DoubleTypeAnnotation':
      return RCTBridgingTo('Double');
    case 'BooleanTypeAnnotation':
      return RCTBridgingTo('Bool');
    case 'GenericObjectTypeAnnotation':
      return value;
    case 'ArrayTypeAnnotation':
      const {elementType} = typeAnnotation;
      if (elementType == null) {
        return value;
      }

      const localVarName = `itemValue_${depth}`;
      const elementObjCType = toObjCType(moduleName, elementType);
      const elementObjCValue = toObjCValue(
        moduleName,
        elementType,
        localVarName,
        depth + 1,
      );

      return RCTBridgingTo(
        'Vec',
        `^${elementObjCType}(id ${localVarName}) { return ${elementObjCValue}; }`,
      );
    case 'TypeAliasTypeAnnotation':
      const structName = capitalize(typeAnnotation.name);
      const namespacedStructName = getNamespacedStructName(
        moduleName,
        structName,
      );

      return !isRequired
        ? `(p == nil ? folly::none : folly::make_optional(${namespacedStructName}(p)))`
        : `${namespacedStructName}(p)`;
    default:
      (typeAnnotation.type: empty);
      throw new Error(
        `Couldn't convert into ObjC value: ${typeAnnotation.type}"`,
      );
  }
}

function serializeRegularStruct(
  moduleName: string,
  struct: RegularStruct,
): StructSerilizationOutput {
  const declaration = StructTemplate({
    moduleName: moduleName,
    structName: struct.name,
    structProperties: struct.properties
      .map(property => {
        const {typeAnnotation, optional} = property;
        const propName = getSafePropertyName(property);
        const returnType = toObjCType(moduleName, typeAnnotation, optional);

        const padding = ' '.repeat(returnType.endsWith('*') ? 0 : 1);
        return `${returnType}${padding}${propName}() const;`;
      })
      .join('\n      '),
  });

  const methods = struct.properties
    .map<string>(property => {
      const {typeAnnotation, optional} = property;
      const propName = getSafePropertyName(property);
      const returnType = toObjCType(moduleName, typeAnnotation, optional);
      const returnValue = toObjCValue(
        moduleName,
        typeAnnotation,
        'p',
        0,
        optional,
      );

      const padding = ' '.repeat(returnType.endsWith('*') ? 0 : 1);
      return MethodTemplate({
        moduleName,
        structName: struct.name,
        returnType: returnType + padding,
        returnValue: returnValue,
        propertyName: propName,
      });
    })
    .join('\n');

  return {methods, declaration};
}

module.exports = {
  serializeRegularStruct,
};