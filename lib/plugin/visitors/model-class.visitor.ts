import { compact, flatten, head } from 'lodash';
import { createWrappedNode, Decorator, PropertyDeclaration } from 'ts-morph';
import * as ts from 'typescript';
import {
  ApiHideProperty,
  ApiProperty,
  ApiPropertyOptional
} from '../../decorators';
import { PluginOptions } from '../merge-options';
import { OPENAPI_NAMESPACE } from '../plugin-constants';
import {
  getDecoratorOrUndefinedByNames,
  getTypeReferenceAsString,
  hasPropertyKey,
  replaceImportPath
} from '../utils/plugin-utils';
import { AbstractFileVisitor } from './abstract.visitor';

export class ModelClassVisitor extends AbstractFileVisitor {
  visit(
    sourceFile: ts.SourceFile,
    ctx: ts.TransformationContext,
    program: ts.Program,
    options: PluginOptions
  ) {
    const typeChecker = program.getTypeChecker();
    sourceFile = this.updateImports(sourceFile);

    const visitNode = (node: ts.Node): ts.Node => {
      if (ts.isPropertyDeclaration(node)) {
        const wrappedNode = createWrappedNode(node, {
          typeChecker
        });
        const decorators = wrappedNode.getDecorators();
        const hidePropertyDecorator = getDecoratorOrUndefinedByNames(
          [ApiHideProperty.name],
          decorators
        );
        if (hidePropertyDecorator) {
          return node;
        }
        const propertyDecorator = getDecoratorOrUndefinedByNames(
          [ApiProperty.name, ApiPropertyOptional.name],
          decorators
        );

        if (!propertyDecorator) {
          return this.addDecoratorToNode(
            wrappedNode,
            options,
            sourceFile.fileName
          );
        }
        return this.addPropertiesToExisitingDecorator(
          propertyDecorator,
          wrappedNode,
          node,
          options,
          sourceFile.fileName
        );
      }
      return ts.visitEachChild(node, visitNode, ctx);
    };
    return ts.visitNode(sourceFile, visitNode);
  }

  addDecoratorToNode(
    node: PropertyDeclaration,
    options: PluginOptions,
    hostFilename: string
  ): ts.PropertyDeclaration {
    const compilerNode = ts.getMutableClone(node.compilerNode);
    const { pos, end } = compilerNode.decorators || ts.createNodeArray();

    compilerNode.decorators = Object.assign(
      [
        ...(compilerNode.decorators || ts.createNodeArray()),
        ts.createDecorator(
          ts.createCall(
            ts.createIdentifier(`${OPENAPI_NAMESPACE}.${ApiProperty.name}`),
            undefined,
            [
              this.createDecoratorObjectLiteralExpr(
                node,
                [],
                options,
                hostFilename
              )
            ]
          )
        )
      ],
      { pos, end }
    );
    return compilerNode;
  }

  addPropertiesToExisitingDecorator(
    existingDecorator: Decorator,
    wrappedNode: PropertyDeclaration,
    originalNode: ts.Node,
    options: PluginOptions,
    hostFilename: string
  ): ts.Node {
    const compilerNode = ts.getMutableClone(existingDecorator.compilerNode);
    const callExpr = compilerNode.expression as ts.CallExpression;
    if (!callExpr) {
      return originalNode;
    }
    const callArgs = callExpr.arguments;
    if (!callArgs) {
      return originalNode;
    }
    const { pos, end } = callArgs;
    const decoratorArgument = head(callArgs) as ts.ObjectLiteralExpression;
    if (!decoratorArgument) {
      callExpr.arguments = Object.assign(
        [
          this.createDecoratorObjectLiteralExpr(
            wrappedNode,
            [],
            options,
            hostFilename
          )
        ],
        { pos, end }
      );
    }

    const decoratorProperties =
      (decoratorArgument && decoratorArgument.properties) || [];

    callExpr.arguments = Object.assign(
      [
        this.createDecoratorObjectLiteralExpr(
          wrappedNode,
          decoratorProperties as ts.PropertyAssignment[],
          options,
          hostFilename
        )
      ],
      {
        pos,
        end
      }
    );
    return originalNode;
  }

  createDecoratorObjectLiteralExpr(
    node: PropertyDeclaration,
    existingProperties: ts.PropertyAssignment[] = [],
    options: PluginOptions = {},
    hostFilename: string = ''
  ): ts.ObjectLiteralExpression {
    const isRequired = !node.hasQuestionToken();

    let properties = [
      ...existingProperties,
      !hasPropertyKey('required', existingProperties) &&
        ts.createPropertyAssignment('required', ts.createLiteral(isRequired)),
      this.createTypePropertyAssignment(node, existingProperties, hostFilename),
      this.createDefaultPropertyAssignment(node, existingProperties),
      this.createEnumPropertyAssignment(node, existingProperties, hostFilename)
    ];
    if (options.classValidatorShim) {
      properties = properties.concat(
        this.createValidationPropertyAssignments(node)
      );
    }
    return ts.createObjectLiteral(compact(flatten(properties)));
  }

  createTypePropertyAssignment(
    node: PropertyDeclaration,
    existingProperties: ts.PropertyAssignment[],
    hostFilename: string
  ) {
    const key = 'type';
    if (hasPropertyKey(key, existingProperties)) {
      return undefined;
    }
    const type = node.getType();
    if (!type) {
      return undefined;
    }
    let typeReference = getTypeReferenceAsString(type);
    if (!typeReference) {
      return undefined;
    }
    typeReference = replaceImportPath(typeReference, hostFilename);
    return ts.createPropertyAssignment(
      key,
      ts.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        undefined,
        ts.createIdentifier(typeReference)
      )
    );
  }

  createEnumPropertyAssignment(
    node: PropertyDeclaration,
    existingProperties: ts.PropertyAssignment[],
    hostFilename: string
  ) {
    const key = 'enum';
    if (hasPropertyKey(key, existingProperties)) {
      return undefined;
    }
    let type = node.getType();
    if (!type) {
      return undefined;
    }
    let isArray = false;
    if (type.isArray()) {
      type = type.getArrayElementType();
      isArray = true;
      if (!type) {
        return undefined;
      }
    }
    if (!type.isEnum()) {
      return undefined;
    }
    const enumRef = replaceImportPath(type.getText(), hostFilename);
    const enumProperty = ts.createPropertyAssignment(
      key,
      ts.createIdentifier(enumRef)
    );
    if (isArray) {
      const isArrayKey = 'isArray';
      const isArrayProperty = ts.createPropertyAssignment(
        isArrayKey,
        ts.createIdentifier('true')
      );
      return [enumProperty, isArrayProperty];
    }
    return enumProperty;
  }

  createDefaultPropertyAssignment(
    node: PropertyDeclaration,
    existingProperties: ts.PropertyAssignment[]
  ) {
    const key = 'default';
    if (hasPropertyKey(key, existingProperties)) {
      return undefined;
    }
    const initializer = node.getInitializer();
    if (!initializer) {
      return undefined;
    }
    return ts.createPropertyAssignment(
      key,
      ts.createIdentifier(initializer.getText())
    );
  }

  createValidationPropertyAssignments(
    node: PropertyDeclaration
  ): ts.PropertyAssignment[] {
    const assignments = [];
    const decorators = node.getDecorators();

    this.addPropertyByValidationDecorator(
      'Min',
      'minimum',
      decorators,
      assignments
    );
    this.addPropertyByValidationDecorator(
      'Max',
      'maximum',
      decorators,
      assignments
    );
    this.addPropertyByValidationDecorator(
      'MinLength',
      'minLength',
      decorators,
      assignments
    );
    this.addPropertyByValidationDecorator(
      'MaxLength',
      'maxLength',
      decorators,
      assignments
    );

    return assignments;
  }

  addPropertyByValidationDecorator(
    decoratorName: string,
    propertyKey: string,
    decorators: Decorator[],
    assignments: ts.PropertyAssignment[]
  ) {
    const decoratorRef = getDecoratorOrUndefinedByNames(
      [decoratorName],
      decorators
    );
    if (!decoratorRef) {
      return;
    }
    const argument = head(decoratorRef.getArguments());
    assignments.push(
      ts.createPropertyAssignment(
        propertyKey,
        ts.createIdentifier(argument && argument.getText())
      )
    );
  }
}
