import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity.js';
import { UserLanguage } from './user.enums.js';
import type { ProfileDto } from './dto/profile.dto.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  toProfile(user: User): ProfileDto {
    return {
      id: user.id,
      phone: user.phone,
      fullName: user.fullName,
      dateOfBirth: user.dateOfBirth,
      preferredLanguage: user.preferredLanguage,
      verificationStatus: user.verificationStatus,
      verifiedAt: user.verifiedAt,
      createdAt: user.createdAt,
    };
  }

  /**
   * The only user-editable field in Phase 1. Updates that one column — never a full entity save —
   * so it can't touch verification_status, full_name or date_of_birth (hard rule 9, V9).
   */
  async updatePreferredLanguage(
    userId: string,
    language: UserLanguage,
  ): Promise<User> {
    await this.users.update({ id: userId }, { preferredLanguage: language });
    return this.users.findOneByOrFail({ id: userId });
  }
}
